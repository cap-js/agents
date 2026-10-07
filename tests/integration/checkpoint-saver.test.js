import cds from "@sap/cds"
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

const MESSAGES = "cap.agent.Messages"

function runAs(userId, fn) {
  return cds.tx({ user: new cds.User({ id: userId }) }, fn)
}

function checkpoint(id, messages, extra = {}) {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
    channel_values: { messages, ...extra },
  }
}

describe("CdsCheckpointSaver", () => {
  it("stores conversation messages once and keeps reasoning out of persistence", async () => {
    const saver = new CdsCheckpointSaver()
    const threadId = `conversation-${cds.utils.uuid()}`
    const human = new HumanMessage({ id: "user-1", content: "hello" })
    const assistant = new AIMessage({
      id: "assistant-1",
      content: [
        { type: "reasoning", reasoning: "private" },
        { type: "text", text: "hello back" },
      ],
      additional_kwargs: { reasoning_content: "private" },
    })

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId, _service: "TestService" } },
        checkpoint("checkpoint-1", [human, assistant]),
        { source: "loop", step: 0 },
      ),
    )

    const rows = await SELECT.from(MESSAGES)
      .where({ session: threadId, createdBy: "alice" })
      .orderBy("sequence")
    expect(rows).toHaveLength(2)
    expect(rows.some(({ role }) => role === "runtime")).toBe(false)
    expect(rows.some(({ query }) => query?.stored)).toBe(false)
    expect(rows.some(({ content }) => content?.includes("private"))).toBe(false)

    const tuple = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: threadId } }),
    )
    expect(tuple.checkpoint.channel_values.messages.map((message) => message.content)).toEqual([
      "hello",
      [{ type: "text", text: "hello back" }],
    ])
  })

  it("does not persist non-message LangGraph state", async () => {
    const saver = new CdsCheckpointSaver()
    const threadId = `state-${cds.utils.uuid()}`

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("checkpoint-1", [new HumanMessage("hello")], { cart: { book: 201 } }),
        { source: "loop", step: 4 },
      ),
    )

    const tuple = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: threadId } }),
    )
    expect(tuple.checkpoint.channel_values.cart).toBe(undefined)
    expect(tuple.metadata).toEqual({})
    expect(tuple.checkpoint.channel_values.messages[0].content).toBe("hello")
    expect(await SELECT.from(MESSAGES).where({ session: threadId })).toHaveLength(1)
  })

  it("round-trips tool calls through neutral message fields", async () => {
    const saver = new CdsCheckpointSaver()
    const threadId = `tools-${cds.utils.uuid()}`
    const messages = [
      new HumanMessage({ id: "user-tool", content: "look it up" }),
      new AIMessage({
        id: "assistant-tool",
        content: "",
        tool_calls: [{ id: "call-1", name: "lookup", args: { id: 7 } }],
      }),
      new ToolMessage({
        id: "tool-result",
        content: '{"title":"Wuthering Heights"}',
        tool_call_id: "call-1",
        name: "lookup",
      }),
    ]

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId, _taskId: "user-tool" } },
        checkpoint("ignored", messages),
        {},
      ),
    )

    const rows = await SELECT.from(MESSAGES).where({ session: threadId }).orderBy("sequence")
    expect(rows[1].query).toEqual({
      toolCalls: [{ id: "call-1", name: "lookup", args: { id: 7 } }],
    })
    expect(rows.some(({ query }) => query?.stored)).toBe(false)

    const tuple = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: threadId } }),
    )
    expect(tuple.checkpoint.channel_values.messages[1].tool_calls[0]).toMatchObject({
      id: "call-1",
      name: "lookup",
      args: { id: 7 },
    })
    expect(tuple.checkpoint.channel_values.messages[2].tool_call_id).toBe("call-1")
  })

  it("does not persist LangGraph pending-write metadata", async () => {
    const saver = new CdsCheckpointSaver()
    const threadId = `interrupt-${cds.utils.uuid()}`
    const config = { configurable: { thread_id: threadId } }

    const saved = await runAs("alice", () =>
      saver.put(config, checkpoint("checkpoint-1", []), { source: "loop", step: 0 }),
    )
    await runAs("alice", () =>
      saver.putWrites(saved, [["__interrupt__", { action: "approve" }]], "node-1"),
    )

    expect(await runAs("alice", () => saver.getTuple(config))).toBe(undefined)
  })

  it("isolates and deletes sessions by user", async () => {
    const saver = new CdsCheckpointSaver()
    const threadId = `isolated-${cds.utils.uuid()}`
    await runAs("alice", () => saver.put({}, checkpoint("ignored", []), {}).catch(() => undefined))
    await runAs("alice", () =>
      saver.put({ configurable: { thread_id: threadId } }, checkpoint("alice", []), {}),
    )

    expect(
      await runAs("bob", () => saver.getTuple({ configurable: { thread_id: threadId } })),
    ).toBe(undefined)
    await runAs("alice", () => saver.deleteThread(threadId))
    expect(
      await runAs("alice", () => saver.getTuple({ configurable: { thread_id: threadId } })),
    ).toBe(undefined)
  })
})
