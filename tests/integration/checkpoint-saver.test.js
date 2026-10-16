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
    const human = new HumanMessage({ content: "hello" })
    const assistant = new AIMessage({
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

    assistant.content = "updated response"
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("checkpoint-2", [assistant, human]),
      ),
    )
    const updated = await SELECT.from(Messages)
      .where({ session: contextId, agentService: "TestService", createdBy: "alice" })
      .orderBy("sequence")
    expect(updated).toHaveLength(2)
    expect(updated.map(({ query }) => query.messageId)).toEqual([human.id, assistant.id])
    expect(updated[1].content).toBe("hello back")
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

  it("persists marked human messages as HITL decisions", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `decision-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
    const decision = new HumanMessage({
      content: "approve",
      additional_kwargs: { "sap.cds.agents.type": "decision" },
    })

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("decision-checkpoint", [decision]),
      ),
    )

    const row = await SELECT.one.from(Messages).where({ session: contextId })
    expect(row.type).toBe("decision")
    expect(row.query.messageId).toBe(decision.id)
  })

  it("round-trips tool calls through neutral message fields", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `tools-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
    const messages = [
      new HumanMessage({ content: "look it up" }),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-1", name: "lookup", args: { id: 7 } },
          { id: "call-2", name: "lookup", args: { id: 8 } },
        ],
      }),
      new ToolMessage({
        content: '{"title":"Wuthering Heights"}',
        tool_call_id: "call-1",
        name: "lookup",
      }),
    ]

    await runAs("alice", () =>
      saver.put({ configurable: { thread_id: threadId } }, checkpoint("ignored", messages), {}),
    )

    const rows = await SELECT.from(Messages)
      .where({ session: contextId })
      .orderBy("createdAt", "sequence")
    expect(rows.filter(({ type }) => type === "tool_call")).toHaveLength(2)
    expect(rows[1].query).toEqual({
      toolCall: { id: "call-1", name: "lookup", args: { id: 7 } },
      messageId: messages[1].id,
    })
    expect(rows[2].query.toolCall.id).toBe("call-2")
    expect(rows[3].query.messageId).toBe(messages[2].id)
    expect(rows[3].query.toolCallId).toBe("call-1")
    expect(rows.some(({ query }) => query?.stored)).toBe(false)

    const tuple = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: threadId } }),
    )
    expect(tuple.checkpoint.channel_values.messages[1].tool_calls[0]).toMatchObject({
      id: "call-1",
      name: "lookup",
      args: { id: 7 },
    })
    expect(tuple.checkpoint.channel_values.messages[1].tool_calls[1].id).toBe("call-2")
    expect(tuple.checkpoint.channel_values.messages[2].tool_call_id).toBe("call-1")
  })

  it("groups rows by logical message identity without merging adjacent messages", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `groups-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`

    await runAs("alice", () =>
      INSERT.into(Messages).entries([
        {
          ID: cds.utils.uuid(),
          session: contextId,
          sequence: 0,
          role: "ai",
          type: "text",
          content: "first",
          query: { messageId: "assistant-1" },
          agentService: "TestService",
        },
        {
          ID: cds.utils.uuid(),
          session: contextId,
          sequence: 1,
          role: "ai",
          type: "text",
          content: " message",
          query: { messageId: "assistant-1" },
          agentService: "TestService",
        },
        {
          ID: "assistant-2",
          session: contextId,
          sequence: 2,
          role: "ai",
          type: "text",
          content: "second",
          agentService: "TestService",
        },
      ]),
    )

    const tuple = await runAs("alice", () =>
      saver.getTuple({ configurable: { thread_id: threadId } }),
    )
    expect(
      tuple.checkpoint.channel_values.messages.map(({ id, content }) => ({ id, content })),
    ).toEqual([
      { id: expect.any(String), content: "first message" },
      { id: "assistant-2", content: "second" },
    ])
  })

  it("assigns new rows their checkpoint positions without moving existing rows", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `sequence-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
    const firstTask = new HumanMessage({ content: "first" })
    const firstAi = new AIMessage({ content: "done" })
    const secondTask = new HumanMessage({ content: "second" })
    const secondAi = new AIMessage({ content: "done" })

    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("first-checkpoint", [firstTask, firstAi]),
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("second-checkpoint", [firstTask, firstAi, secondTask, secondAi]),
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint("second-checkpoint", [firstTask, firstAi, secondTask, secondAi]),
      ),
    )

    const ordered = await SELECT.from(Messages)
      .where({ session: contextId })
      .orderBy("createdAt", "sequence")
    expect(ordered.map(({ sequence }) => Number(sequence))).toEqual([0, 1, 2, 3])
    expect(ordered.map(({ query }) => query.messageId)).toEqual([
      firstTask.id,
      firstAi.id,
      secondTask.id,
      secondAi.id,
    ])
  })

  it("persists HITL interrupt metadata on each matching tool-call row", async () => {
    const { Messages } = cds.entities("cap.agent")
    const saver = new CdsCheckpointSaver()
    const contextId = `interrupt-${cds.utils.uuid()}`
    const threadId = `TestService:${contextId}`
    const config = { configurable: { thread_id: threadId } }
    const calls = [
      { id: cds.utils.uuid(), name: "approveMe", args: { id: 1 } },
      { id: cds.utils.uuid(), name: "skipMe", args: { id: 2 } },
      { id: cds.utils.uuid(), name: "approveMeToo", args: { id: 3 } },
    ]

    const value = {
      actionRequests: [
        { name: "approveMe", args: { id: 1 } },
        { name: "approveMeToo", args: { id: 3 } },
      ],
    }
    await runAs("alice", async () => {
      await saver.putWrites(config, [["__interrupt__", [{ value }]]], "node-1")
      await saver.put(
        config,
        checkpoint("checkpoint-1", [new AIMessage({ content: "", tool_calls: calls })]),
        { source: "loop", step: 0 },
      )
    })

    const rows = await SELECT.from(Messages).where({ session: contextId }).orderBy("sequence")
    expect(rows.filter((row) => row.query.inputRequired)).toHaveLength(2)
    expect(rows.find((row) => row.query.toolCall.id === calls[1].id).query.inputRequired).toBe(
      undefined,
    )
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
        checkpoint("first", [new HumanMessage({ content: "first" })]),
        {},
      ),
    )
    await runAs("alice", () =>
      saver.put(
        { configurable: { thread_id: secondThread } },
        checkpoint("second", [new HumanMessage({ content: "second" })]),
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
