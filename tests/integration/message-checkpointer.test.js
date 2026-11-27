import cds from "@sap/cds"
import { serialize, deserialize } from "node:v8"
import { emptyCheckpoint, ERROR } from "@langchain/langgraph-checkpoint"
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"
import { CdsMessageStore, sessionId } from "../../lib/protocol/persistence/message-store.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

const asUser = (user, fn) => cds.tx({ user: new cds.User({ id: user }) }, fn)
const meta = { source: "loop", step: 0, parents: {} }
const config = (thread, namespace = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
})
const checkpoint = (values = {}, version = 1) => ({
  ...emptyCheckpoint(),
  channel_values: values,
  channel_versions: Object.fromEntries(Object.keys(values).map((key) => [key, version])),
})

describe("Message-backed checkpointer", () => {
  it("isolates identical checkpoint, value, and task IDs by owner", async () => {
    const thread = cds.utils.uuid()
    const cp = checkpoint({ text: "alice" })
    const saver = new CdsCheckpointSaver()
    for (const user of ["alice", "bob"]) {
      // eslint-disable-next-line no-await-in-loop
      await asUser(user, async () => {
        const saved = await saver.put(
          config(thread),
          { ...cp, channel_values: { text: user } },
          meta,
          cp.channel_versions,
        )
        await saver.putWrites(saved, [["text", user]], "same-task")
      })
    }
    await asUser("alice", async () => {
      const tuple = await saver.getTuple(config(thread))
      expect(tuple.checkpoint.channel_values).toEqual({ text: "alice" })
      expect(tuple.pendingWrites).toEqual([["same-task", "text", "alice"]])
      await saver.deleteThread(thread)
      expect(await saver.getTuple(config(thread))).toBeUndefined()
    })
    await asUser("bob", async () => {
      const tuple = await saver.getTuple(config(thread))
      expect(tuple.checkpoint.channel_values).toEqual({ text: "bob" })
      expect(tuple.pendingWrites).toEqual([["same-task", "text", "bob"]])
    })
  })

  it("keeps the A2A context ID and deletes only one service's records", async () => {
    const contextId = cds.utils.uuid()
    await asUser("alice", async () => {
      const saver = new CdsCheckpointSaver()
      await saver.put(config(`FirstService:${contextId}`), checkpoint(), meta, {})
      await saver.put(config(`SecondService:${contextId}`), checkpoint(), meta, {})
      const rows = await SELECT.from("cap.agent.Messages").where({ session: contextId })
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => Number(row.sequence)).sort((a, b) => a - b)).toEqual([1, 2])
      await saver.deleteThread(`FirstService:${contextId}`)
      expect(await saver.getTuple(config(`FirstService:${contextId}`))).toBeUndefined()
      expect(await saver.getTuple(config(`SecondService:${contextId}`))).toBeDefined()
      expect(
        await SELECT.one.from("cap.agent.Sessions").where({ ID: contextId, owner: "alice" }),
      ).toBeDefined()
      await saver.deleteThread(`SecondService:${contextId}`)
      expect(
        await SELECT.one.from("cap.agent.Sessions").where({ ID: contextId, owner: "alice" }),
      ).toBeUndefined()
    })
  })

  it("restores LangChain messages and pending writes in a fresh saver", async () => {
    const thread = cds.utils.uuid()
    const messages = [
      new HumanMessage({ id: "user-1", content: "hello" }),
      new AIMessage({
        id: "ai-1",
        content: "",
        tool_calls: [{ id: "call-1", name: "lookup", args: { city: "Berlin" } }],
      }),
      new ToolMessage({ content: "found", tool_call_id: "call-1" }),
    ]
    let saved
    await asUser("alice", async () => {
      const saver = new CdsCheckpointSaver()
      const cp = checkpoint({ messages })
      saved = await saver.put(config(thread), cp, meta, cp.channel_versions)
      await saver.putWrites(saved, [["messages", [new AIMessage("done")]]], "task")
    })
    await asUser("alice", async () => {
      const tuple = await new CdsCheckpointSaver().getTuple(saved)
      expect(tuple.checkpoint.channel_values.messages).toEqual(messages)
      expect(tuple.pendingWrites[0][2][0]).toBeInstanceOf(AIMessage)
    })
  })

  it("preserves custom serializer types and arbitrary binary bytes", async () => {
    const serde = {
      dumpsTyped: (value) => ["v8", serialize(value)],
      loadsTyped: (type, bytes) => {
        expect(type).toBe("v8")
        return deserialize(Buffer.from(bytes))
      },
    }
    await asUser("binary-user", async () => {
      const value = new Uint8Array([0, 255, 192, 128])
      const cp = checkpoint({ value })
      const saved = await new CdsCheckpointSaver(serde).put(
        config(cds.utils.uuid()),
        cp,
        meta,
        cp.channel_versions,
      )
      expect(
        (await new CdsCheckpointSaver(serde).getTuple(saved)).checkpoint.channel_values.value,
      ).toEqual(value)
    })
  })

  it("serializes concurrent appends in a shared transaction and deduplicates retries", async () => {
    const thread = cds.utils.uuid()
    await asUser("parallel-user", async () => {
      const saver = new CdsCheckpointSaver()
      const saved = await saver.put(config(thread), checkpoint(), meta, {})
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          new CdsCheckpointSaver().putWrites(saved, [["value", i]], `task-${i}`, `path-${i}`),
        ),
      )
      await saver.putWrites(saved, [["value", "retry"]], "task-0")
      await saver.putWrites(saved, [[ERROR, "first"]], "error-task")
      await saver.putWrites(saved, [[ERROR, "updated"]], "error-task")
      const writes = (await saver.getTuple(saved)).pendingWrites
      expect(writes).toHaveLength(13)
      expect(writes.find(([task]) => task === "task-0")[2]).toBe(0)
      expect(writes.find(([task]) => task === "error-task")[2]).toBe("updated")
      const rows = await SELECT.from("cap.agent.Messages").where({
        session: thread,
        createdBy: "parallel-user",
      })
      expect(new Set(rows.map((row) => row.sequence)).size).toBe(rows.length)
    })
  })

  it("serializes appends across independent transactions", async () => {
    const thread = cds.utils.uuid()
    let saved
    await asUser("parallel-user", async () => {
      saved = await new CdsCheckpointSaver().put(config(thread), checkpoint(), meta, {})
    })
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        asUser("parallel-user", () =>
          new CdsCheckpointSaver().putWrites(saved, [["value", i]], `task-${i}`),
        ),
      ),
    )
    await asUser("parallel-user", async () => {
      expect((await new CdsCheckpointSaver().getTuple(saved)).pendingWrites).toHaveLength(8)
    })
  })

  it("rolls back the complete message batch with its request transaction", async () => {
    const thread = cds.utils.uuid()
    await expect(
      asUser("rollback-user", async () => {
        const cp = checkpoint({ value: 1 })
        await new CdsCheckpointSaver().put(config(thread), cp, meta, cp.channel_versions)
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    expect(await SELECT.from("cap.agent.Messages").where({ session: thread })).toHaveLength(0)
    expect(await SELECT.from("cap.agent.Sessions").where({ ID: thread })).toHaveLength(0)
  })

  it("preserves branch ancestry through prev and immutable channel versions", async () => {
    await asUser("fork-user", async () => {
      const saver = new CdsCheckpointSaver()
      const thread = cds.utils.uuid()
      const cp = checkpoint({ value: "root" })
      const parent = await saver.put(config(thread), cp, meta, cp.channel_versions)
      const a = checkpoint({ value: "branch-a" }, saver.getNextVersion(1))
      const b = checkpoint({ value: "branch-b" }, saver.getNextVersion(1))
      const ca = await saver.put(parent, a, meta, a.channel_versions)
      const cb = await saver.put(parent, b, meta, b.channel_versions)
      expect((await saver.getTuple(ca)).checkpoint.channel_values.value).toBe("branch-a")
      expect((await saver.getTuple(cb)).checkpoint.channel_values.value).toBe("branch-b")
      const rows = await SELECT.from("cap.agent.Messages").where({ session: thread })
      const snapshots = rows.filter((r) => r.query.kind === "checkpoint")
      const root = snapshots.find((r) => r.query.id === cp.id)
      expect(snapshots.filter((r) => r.ID !== root.ID).map((r) => r.prev_ID)).toEqual([
        root.ID,
        root.ID,
      ])
    })
  })

  it("keeps arbitrary thread IDs and unrelated conversation messages intact", async () => {
    const thread = `non-uuid-${cds.utils.uuid()}`
    await asUser("alice", async () => {
      const saver = new CdsCheckpointSaver()
      await saver.put(config(thread), checkpoint(), meta, {})
      const ID = cds.utils.uuid()
      await new CdsMessageStore().mutate(thread, (store) =>
        store.put({ ID, role: "user", type: "text", content: "hello" }),
      )
      await saver.deleteThread(thread)
      expect(await saver.getTuple(config(thread))).toBeUndefined()
      expect(await SELECT.one.from("cap.agent.Messages").where({ ID })).toMatchObject({
        content: "hello",
        session: sessionId(thread),
      })
    })
  })

  it("applies metadata filters before limits and handles identical IDs across namespaces", async () => {
    await asUser("list-user", async () => {
      const saver = new CdsCheckpointSaver()
      const thread = cds.utils.uuid()
      const cp = checkpoint()
      for (const namespace of ["", "child"]) {
        // eslint-disable-next-line no-await-in-loop
        await saver.put(config(thread, namespace), cp, { ...meta, detail: { namespace } }, {})
      }
      // Omit the namespace entirely to search all namespaces.
      const all = await Array.fromAsync(saver.list({ configurable: { thread_id: thread } }))
      expect(all).toHaveLength(2)
      expect(await Array.fromAsync(saver.list(config(thread), { limit: 0 }))).toHaveLength(0)
      const filtered = await Array.fromAsync(
        saver.list(
          { configurable: { thread_id: thread } },
          { filter: { detail: { namespace: "child" } }, limit: 1 },
        ),
      )
      expect(filtered).toHaveLength(1)
      expect(filtered[0].config.configurable.checkpoint_ns).toBe("child")
    })
  })
})
