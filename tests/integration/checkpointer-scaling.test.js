/* eslint-disable no-await-in-loop */
import cds from "@sap/cds"
import { createHash } from "node:crypto"
import { serialize, deserialize } from "node:v8"
import {
  BaseCheckpointSaver,
  emptyCheckpoint,
  isDeltaSnapshot,
} from "@langchain/langgraph-checkpoint"
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  MessagesDeltaValue,
  START,
  END,
} from "@langchain/langgraph"
import { HumanMessage, RemoveMessage } from "@langchain/core/messages"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"

cds.test(import.meta.dirname + "/../projects/bookshop")
const asUser = (fn) => cds.tx({ user: new cds.User({ id: "scaling-user" }) }, fn)
const config = (thread, namespace = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
})
const metadata = { source: "loop", step: 0, parents: {} }
const payload = (n) =>
  Array.from({ length: 24 }, (_, i) =>
    createHash("sha256")
      .update(n + ":" + i)
      .digest("hex"),
  ).join("")
const checkpoint = (value, version) => ({
  ...emptyCheckpoint(),
  channel_values: { messages: value },
  channel_versions: { messages: version },
})
const rowsFor = (thread) =>
  SELECT.from("cap.agent.Messages").where({ session: thread, createdBy: "scaling-user" })
const sizeOf = (rows) => rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)

it("shares ordinary full histories, early edits, forks, and large pending writes across fresh savers", async ({
  task,
}) => {
  const thread = cds.utils.uuid()
  let midway
  let bytes128
  let saved
  const history = []
  await asUser(async () => {
    for (let i = 1; i <= 256; i++) {
      history.push(new HumanMessage({ id: "message-" + i, content: payload(i) }))
      saved = await new CdsCheckpointSaver().put(
        saved ?? config(thread),
        checkpoint(history, i),
        metadata,
      )
      if (i === 128) {
        midway = saved
        bytes128 = sizeOf(await rowsFor(thread))
      }
    }
    const rows = await rowsFor(thread)
    const bytes256 = sizeOf(rows)
    task.meta.storage = {
      bytes128,
      bytes256,
      ratio: bytes256 / bytes128,
      rows: rows.length,
    }
    expect(bytes256 / bytes128).toBeLessThan(2.8)
    expect(
      (await new CdsCheckpointSaver().getTuple(midway)).checkpoint.channel_values.messages,
    ).toEqual(history.slice(0, 128))
    expect(
      (await new CdsCheckpointSaver().getTuple(saved)).checkpoint.channel_values.messages,
    ).toEqual(history)

    const changed = [
      new HumanMessage({ id: "inserted", content: payload("inserted") }),
      ...history.slice(1),
    ]
    changed[4] = new HumanMessage({ id: "replacement", content: payload("replacement") })
    changed.splice(10, 1)
    const branch = await new CdsCheckpointSaver().put(midway, checkpoint(changed, 257), metadata)
    const forkRows = await rowsFor(thread)
    const originalChunks = new Set(
      rows.filter((row) => row.category === "chunk").map((row) => row.ID),
    )
    const freshChunkBytes = forkRows
      .filter((row) => row.category === "chunk" && !originalChunks.has(row.ID))
      .reduce((sum, row) => sum + row.content.length, 0)
    expect(freshChunkBytes).toBeLessThan(JSON.stringify(changed).length / 3)
    expect(
      (await new CdsCheckpointSaver().getTuple(branch)).checkpoint.channel_values.messages,
    ).toEqual(changed)
    expect(
      (await new CdsCheckpointSaver().getTuple(saved)).checkpoint.channel_values.messages,
    ).toEqual(history)
    await new CdsCheckpointSaver().putWrites(branch, [["messages", changed]], "large-write")
    // Same bytes in channel values and pending writes share all chunks and nodes.
    const afterWrite = await rowsFor(thread)
    expect(afterWrite.filter((row) => ["chunk", "node"].includes(row.category))).toHaveLength(
      forkRows.filter((row) => ["chunk", "node"].includes(row.category)).length,
    )
    expect((await new CdsCheckpointSaver().getTuple(branch)).pendingWrites[0][2]).toEqual(changed)
    const beforeRetry = sizeOf(afterWrite)
    await new CdsCheckpointSaver().putWrites(
      branch,
      [["messages", [payload("ignored-retry")]]],
      "large-write",
    )
    expect(sizeOf(await rowsFor(thread))).toBe(beforeRetry)
    await new CdsCheckpointSaver().deleteThread(thread)
    expect(await rowsFor(thread)).toHaveLength(0)
  })
}, 120_000)

for (const [mode, messages] of [
  ["ordinary", MessagesValue],
  ["delta", MessagesDeltaValue],
]) {
  it(
    "restores actual " + mode + " message graphs across snapshots, updates, removals and forks",
    async ({ task }) => {
      const thread = cds.utils.uuid()
      const build = () =>
        new StateGraph(new StateSchema({ messages }))
          .addNode("step", () => ({}))
          .addEdge(START, "step")
          .addEdge("step", END)
          .compile({ checkpointer: new CdsCheckpointSaver() })
      let midpoint
      let bytes110
      const expected = []
      await asUser(async () => {
        for (let i = 1; i <= 220; i++) {
          const message = new HumanMessage({ id: "message-" + i, content: payload(i) })
          expected.push(message)
          const state = await build().invoke({ messages: [message] }, config(thread))
          expect(state.messages.at(-1)).toEqual(message)
          if (i === 110) {
            midpoint = (await build().getState(config(thread))).config
            bytes110 = sizeOf(await rowsFor(thread))
          }
        }
        const rows = await rowsFor(thread)
        const bytes220 = sizeOf(rows)
        task.meta.storage = {
          bytes110,
          bytes220,
          ratio: bytes220 / bytes110,
          rows: rows.length,
        }
        expect(bytes220 / bytes110).toBeLessThan(2.8)
        expect((await build().getState(config(thread))).values.messages).toEqual(expected)
        expect((await build().getState(midpoint)).values.messages).toEqual(expected.slice(0, 110))
        if (mode === "delta") {
          const saver = new CdsCheckpointSaver()
          const values = rows.filter(
            (row) =>
              row.category === "value" && row.query.channel === "messages" && !row.query.empty,
          )
          const snapshots = await saver._content().loadMany(values.map((row) => row.content))
          expect(snapshots.filter(isDeltaSnapshot).length).toBeGreaterThanOrEqual(2)
          const latest = (await build().getState(config(thread))).config
          const options = { config: latest, channels: ["messages"] }
          expect(await saver.getDeltaChannelHistory(options)).toEqual(
            await BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(saver, options),
          )
        }
        const replacement = new HumanMessage({ id: "message-1", content: payload("edited") })
        const fork = await build().invoke(
          { messages: [replacement, new RemoveMessage({ id: "message-2" })] },
          midpoint,
        )
        expect(fork.messages).toEqual([replacement, ...expected.slice(2, 110)])
        expect((await build().getState(midpoint)).values.messages).toEqual(expected.slice(0, 110))
      })
    },
    120_000,
  )
}

it("shares custom binary serialization and handles repeated chunks without losing their order", async () => {
  const serde = {
    dumpsTyped: (value) => ["v8", serialize(value)],
    loadsTyped: (_, bytes) => deserialize(Buffer.from(bytes)),
  }
  await asUser(async () => {
    const thread = cds.utils.uuid()
    const value = new Uint8Array(1024 * 1024).fill(255)
    value[600000] = 7
    const saver = new CdsCheckpointSaver(serde)
    const first = await saver.put(config(thread), checkpoint(value, 1), metadata)
    const second = await saver.put(first, checkpoint(value, 2), metadata)
    expect(
      (await new CdsCheckpointSaver(serde).getTuple(second)).checkpoint.channel_values.messages,
    ).toEqual(value)
    const rows = await rowsFor(thread)
    expect(sizeOf(rows)).toBeLessThan(value.length / 3)
    expect(rows.filter((row) => row.category === "node").length).toBeLessThan(100)
  })
})

it("uses bounded latest reads and paginates equal IDs across batches in logical order", async () => {
  await asUser(async () => {
    const thread = cds.utils.uuid()
    const saver = new CdsCheckpointSaver()
    // Physical insertion order differs from logical order, with ties spanning pages.
    for (const id of ["z", "a"]) {
      for (let i = 0; i < 110; i++) {
        await saver.put(
          config(thread, "namespace-" + i),
          { ...emptyCheckpoint(), id },
          metadata,
          {},
        )
      }
    }
    const listConfig = { configurable: { thread_id: thread } }
    const all = await Array.fromAsync(saver.list(listConfig))
    expect(all).toHaveLength(220)
    expect(new Set(all.map((item) => JSON.stringify(item.config))).size).toBe(220)
    expect(all.slice(0, 110).every((item) => item.checkpoint.id === "z")).toBe(true)
    expect(all.slice(110).every((item) => item.checkpoint.id === "a")).toBe(true)
    expect(
      await Array.fromAsync(
        saver.list(listConfig, { before: { configurable: { checkpoint_id: "z" } } }),
      ),
    ).toHaveLength(110)
    let read = 0
    const ordered = saver.store.ordered.bind(saver.store)
    vi.spyOn(saver.store, "ordered").mockImplementation(async function* (...args) {
      for await (const row of ordered(...args)) {
        read++
        yield row
      }
    })
    expect((await saver.getTuple(config(thread, "namespace-0"))).checkpoint.id).toBe("z")
    expect(read).toBe(1)
    expect(saver.store.ordered).toHaveBeenLastCalledWith(expect.any(Object), { limit: 1 })
    read = 0
    expect(await saver.latestNamespace(thread)).toMatch(/^namespace-/)
    expect(read).toBe(1)
    const session = await SELECT.one
      .from("cap.agent.Sessions")
      .where({ ID: thread, owner: "scaling-user" })
    const rows = await rowsFor(thread)
    expect(Number(session.sequence)).toBe(Math.max(...rows.map((row) => Number(row.sequence))))
    expect(new Set(rows.map((row) => row.sequence)).size).toBe(rows.length)
    const statement = await cds
      .tx(cds.context)
      .prepare(
        "EXPLAIN QUERY PLAN SELECT ID FROM cap_agent_Messages WHERE createdBy = ? AND category = ? AND scope = ? AND stream = ? ORDER BY sortKey DESC, ID DESC LIMIT 1",
      )
    const plan = await statement.all(["scaling-user", "checkpoint", rows[0].scope, rows[0].stream])
    expect(plan.some((entry) => /USING (?:COVERING )?INDEX/.test(entry.detail))).toBe(true)
    expect(plan.some((entry) => /SCAN |TEMP B-TREE/.test(entry.detail))).toBe(false)
  })
}, 120_000)
