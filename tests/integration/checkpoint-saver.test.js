import cds from "@sap/cds"
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

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
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `conversation-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
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
        { configurable: { thread_id: threadId } },
        checkpoint("checkpoint-1", [human, assistant]),
        { source: "loop", step: 0 },
      ),
    )

    const rows = await SELECT.from(Messages)
      .where({ session: contextId, agentService: "TestService", createdBy: "alice" })
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
      "hello back",
    ])
    expect(tuple.config.configurable.thread_id).toBe(threadId)
  })

  it("does not persist non-message LangGraph state", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `state-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
    const message = new HumanMessage("hello")

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("checkpoint-1", [message], { cart: { book: 201 } }),
        { source: "loop", step: 4 },
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("checkpoint-2", [message], { cart: { book: 201 } }),
        { source: "loop", step: 5 },
      ),
    )

    const tuple = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: threadId } }),
    )
    expect(message.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    expect(tuple.checkpoint.channel_values.cart).toBe(undefined)
    expect(tuple.metadata).toEqual({})
    expect(tuple.checkpoint.channel_values.messages[0].content).toBe("hello")
    expect(await SELECT.from(Messages).where({ session: contextId })).toHaveLength(1)
  })

  it("round-trips tool calls through neutral message fields", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `tools-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
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

    const rows = await SELECT.from(Messages).where({ session: contextId }).orderBy("sequence")
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

  it("sequences only messages after the latest stored message", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `sequence-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
    const firstTask = new HumanMessage({ id: "first-task", content: "first" })
    const secondTask = new HumanMessage({ id: "second-task", content: "second" })

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId, _taskId: firstTask.id } },
        checkpoint("first-checkpoint", [
          firstTask,
          new AIMessage({ id: "first-ai", content: "done" }),
        ]),
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId, _taskId: secondTask.id } },
        checkpoint("second-checkpoint", [
          firstTask,
          new AIMessage({ id: "first-ai", content: "done" }),
          secondTask,
          new AIMessage({ id: "second-ai", content: "done" }),
        ]),
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId, _taskId: secondTask.id } },
        checkpoint("second-checkpoint", [
          firstTask,
          new AIMessage({ id: "first-ai", content: "done" }),
          secondTask,
          new AIMessage({ id: "second-ai", content: "done" }),
        ]),
      ),
    )

    const rows = await SELECT.from(Messages).where({ session: contextId }).orderBy("sequence")
    expect(rows.map(({ ID }) => ID)).toEqual(["first-task", "first-ai", "second-task", "second-ai"])
    expect(rows.map(({ sequence }) => Number(sequence))).toEqual([0, 1, 2, 3])
  })

  it("does not persist LangGraph pending-write metadata", async () => {
    const saver = new CdsCheckpointSaver()
    const threadId = `TestService:interrupt-${cds.utils.uuid()}`
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
    const threadId = `TestService:isolated-${cds.utils.uuid()}`
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

  it("isolates the same session across agent services", async () => {
    const saver = new CdsCheckpointSaver()
    const contextId = `shared-${cds.utils.uuid()}`
    const firstThread = `FirstService:${contextId}`
    const secondThread = `SecondService:${contextId}`

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: firstThread } },
        checkpoint("first", [new HumanMessage({ id: cds.utils.uuid(), content: "first" })]),
        {},
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: secondThread } },
        checkpoint("second", [new HumanMessage({ id: cds.utils.uuid(), content: "second" })]),
        {},
      ),
    )

    const first = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: firstThread } }),
    )
    const second = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: secondThread } }),
    )
    expect(first.checkpoint.channel_values.messages[0].content).toBe("first")
    expect(second.checkpoint.channel_values.messages[0].content).toBe("second")

    await runAs("alice", () => saver.deleteThread(firstThread))
    expect(
      await runAs("alice", () => saver.getTuple({ configurable: { thread_id: firstThread } })),
    ).toBe(undefined)
    expect(
      await runAs("alice", () => saver.getTuple({ configurable: { thread_id: secondThread } })),
    ).toBeTruthy()
  })
})
