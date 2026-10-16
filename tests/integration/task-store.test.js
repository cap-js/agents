import cds from "@sap/cds"
cds.test(import.meta.dirname + "/../projects/bookshop")
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"
import { CdsTaskStore } from "../../lib/protocol/persistence/task-store.js"

function runAs(userId, fn) {
  return cds.tx({ user: new cds.User({ id: userId }) }, fn)
}

function task(id, state) {
  return {
    id,
    contextId: `context-${id}`,
    kind: "task",
    status: { state },
  }
}

async function createAnchor(taskId, contextId = `context-${taskId}`) {
  const { Messages } = cds.entities("cap.agent")
  await INSERT.into(Messages).entries({
    ID: taskId,
    session: contextId,
    sequence: 0,
    role: "user",
    type: "text",
    content: "",
    query: { messageId: taskId },
    agentService: "TestService",
  })
}

async function saveMessages(taskId, contextId, messages) {
  const saver = new CdsCheckpointSaver()
  for (const message of messages) message.id = undefined
  const config = { configurable: { thread_id: `TestService:${contextId}`, _taskId: taskId } }
  const stored = await saver.getTuple(config)
  await saver.put(config, {
    v: 1,
    id: cds.utils.uuid(),
    ts: new Date().toISOString(),
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
    channel_values: {
      messages: [...(stored?.checkpoint.channel_values.messages ?? []), ...messages],
    },
  })
}

async function saveHitl(contextId, actionRequests) {
  const description =
    actionRequests[0]?.description || `Approve action: ${actionRequests[0]?.name}?`
  return description
}

describe("CdsTaskStore", () => {
  it("projects input-required from an unresolved tool call without persisting the status", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()
    const contextId = `context-${taskId}`
    const toolCall = { id: cds.utils.uuid(), name: "submitOrder", args: { bookId: 42 } }

    await runAs("alice", async () => {
      await createAnchor(taskId, contextId)
      const saver = new CdsCheckpointSaver()
      await saver.putWrites({ configurable: { thread_id: `TestService:${contextId}` } }, [
        [
          "__interrupt__",
          [{ value: { actionRequests: [{ ...toolCall, description: "Approve order?" }] } }],
        ],
      ])
      await saveMessages(taskId, contextId, [
        new AIMessage({ content: "", tool_calls: [toolCall] }),
      ])
      await saveHitl(contextId, [{ ...toolCall, description: "Approve order?" }])

      const { Messages } = cds.entities("cap.agent")
      const requestRows = await SELECT.from(Messages).where({ session: contextId, type: "request" })
      expect(requestRows).toHaveLength(0)

      const current = await store.load(taskId)
      expect(current.status.state).toBe("input-required")
      expect(current.status.message.parts[0].text).toBe("Approve order?")
      expect(current.status.message.parts[1].data.actionRequests).toEqual([
        { ...toolCall, description: "Approve order?" },
      ])
      expect(current.status.message.metadata["sap.cds.agents.hitl"]).toEqual({
        actionCount: 1,
        decisions: [],
        actionRequests: [{ ...toolCall, description: "Approve order?" }],
      })
    })
  })

  it("does not project input-required from a resolved tool call", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()
    const contextId = `context-${taskId}`
    const toolCall = { id: cds.utils.uuid(), name: "submitOrder", args: { bookId: 42 } }

    await runAs("alice", async () => {
      await createAnchor(taskId, contextId)
      const saver = new CdsCheckpointSaver()
      await saver.putWrites({ configurable: { thread_id: `TestService:${contextId}` } }, [
        ["__interrupt__", [{ value: { actionRequests: [toolCall] } }]],
      ])
      await saveMessages(taskId, contextId, [
        new AIMessage({ content: "", tool_calls: [toolCall] }),
      ])

      expect((await store.load(taskId)).status.state).toBe("input-required")

      await saveMessages(taskId, contextId, [
        new ToolMessage({ content: "submitted", tool_call_id: toolCall.id }),
      ])

      expect((await store.load(taskId)).status.state).toBe("submitted")
    })
  })

  it("marks only tool-call rows containing HITL action requests", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()
    const contextId = `context-${taskId}`
    const approved = { id: cds.utils.uuid(), name: "submitOrder", args: { bookId: 42 } }
    const skipped = { id: cds.utils.uuid(), name: "getStock", args: { bookId: 42 } }
    const second = { id: cds.utils.uuid(), name: "deleteOrder", args: { orderId: 7 } }
    const unrelated = { id: cds.utils.uuid(), name: "listOrders", args: {} }
    const duplicate = { ...approved, id: cds.utils.uuid() }
    const actionRequests = [
      { name: approved.name, args: approved.args },
      { name: second.name, args: second.args },
    ]

    await runAs("alice", async () => {
      await createAnchor(taskId, contextId)
      const saver = new CdsCheckpointSaver()
      await saver.putWrites({ configurable: { thread_id: `TestService:${contextId}` } }, [
        ["__interrupt__", [{ value: { actionRequests } }]],
      ])
      await saveMessages(taskId, contextId, [
        new AIMessage({ content: "", tool_calls: [approved, skipped, duplicate] }),
        new AIMessage({ content: "", tool_calls: [second] }),
        new AIMessage({ content: "", tool_calls: [unrelated] }),
      ])
      await saveHitl(contextId, actionRequests)

      const { Messages } = cds.entities("cap.agent")
      const rows = await SELECT.from(Messages).where({ session: contextId, type: "tool_call" })
      expect(rows.filter((row) => row.query.inputRequired)).toHaveLength(2)
      expect(rows.find((row) => row.query.toolCall.id === approved.id)).toMatchObject({
        query: { inputRequired: expect.anything() },
      })
      expect(rows.find((row) => row.query.toolCall.id === second.id)).toMatchObject({
        query: { inputRequired: expect.anything() },
      })
      expect(rows.find((row) => row.query.toolCall.id === unrelated.id).query.inputRequired).toBe(
        undefined,
      )

      await saveMessages(taskId, contextId, [
        new ToolMessage({ content: "stock", tool_call_id: skipped.id }),
      ])
      expect((await store.load(taskId)).status.state).toBe("input-required")

      await saveMessages(taskId, contextId, [
        new ToolMessage({ content: "submitted", tool_call_id: approved.id }),
      ])
      expect((await store.load(taskId)).status.state).toBe("input-required")

      await saveMessages(taskId, contextId, [
        new ToolMessage({ content: "deleted", tool_call_id: second.id }),
      ])
      expect((await store.load(taskId)).status.state).toBe("submitted")
    })
  })

  it("does not persist SDK task state", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await store.save({
        ...task(taskId, "failed"),
        status: {
          state: "failed",
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "agent",
            parts: [{ kind: "text", text: "Failed" }],
          },
        },
      })

      const current = await store.load(taskId)
      expect(current.status.state).toBe("submitted")
      expect(current.history).toHaveLength(1)
    })
  })

  it("projects task state from harness-owned messages", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await saveMessages(taskId, `context-${taskId}`, [new AIMessage("Done")])

      const current = await store.load(taskId)
      expect(current.status.state).toBe("completed")
      expect(current.status.message.parts).toEqual([{ kind: "text", text: "Done" }])
    })
  })

  it("does not project SDK artifacts into message history", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await store.save({
        ...task(taskId, "completed"),
        artifacts: [{ artifactId: "data-0", parts: [{ kind: "data", data: { value: 1 } }] }],
      })
    })

    const current = await runAs("alice", () => store.load(taskId))
    expect(current.status.state).toBe("submitted")
    expect(current.history).toHaveLength(1)
    expect(current.artifacts).toBe(undefined)
  })

  it("isolates database reads by user", async () => {
    const store = new CdsTaskStore()
    const taskId = cds.utils.uuid()

    await runAs("alice", async () => {
      await createAnchor(taskId)
    })

    await runAs("bob", async () => {
      expect(await store.load(taskId)).toBe(undefined)
    })
  })

  it("loads a later task from a session with multiple tasks", async () => {
    const store = new CdsTaskStore()
    const contextId = cds.utils.uuid()
    const firstTaskId = cds.utils.uuid()
    const secondTaskId = cds.utils.uuid()

    await runAs("alice", () => createAnchor(firstTaskId, contextId))
    await runAs("alice", () =>
      saveMessages(firstTaskId, contextId, [new AIMessage("First response")]),
    )
    await runAs("alice", () => createAnchor(secondTaskId, contextId))
    await runAs("alice", () =>
      saveMessages(secondTaskId, contextId, [new AIMessage("Second response")]),
    )

    await runAs("alice", async () => {
      const first = await store.load(firstTaskId)
      const current = await store.load(secondTaskId)
      expect(first.history.map(({ messageId }) => messageId)).toEqual([
        firstTaskId,
        first.status.message.messageId,
      ])
      expect(current.id).toBe(secondTaskId)
      expect(current.history.map(({ messageId }) => messageId)).toEqual([
        firstTaskId,
        first.status.message.messageId,
        secondTaskId,
        current.status.message.messageId,
      ])
      expect(current.status.message.parts).toEqual([{ kind: "text", text: "Second response" }])
    })
  })
})
