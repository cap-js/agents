import cds from "@sap/cds"
cds.test(import.meta.dirname + "/../projects/bookshop")
import { AIMessage, HumanMessage } from "@langchain/core/messages"
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
  await saveMessages(taskId, contextId, [new HumanMessage({ id: taskId, content: "" })])
}

async function saveMessages(taskId, contextId, messages) {
  const saver = new CdsCheckpointSaver()
  await saver.put(
    { configurable: { thread_id: `TestService:${contextId}`, _taskId: taskId } },
    {
      v: 1,
      id: cds.utils.uuid(),
      ts: new Date().toISOString(),
      channel_versions: {},
      versions_seen: {},
      pending_sends: [],
      channel_values: { messages },
    },
  )
}

describe("CdsTaskStore", () => {
  it("persists durable A2A task state", async () => {
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
      expect(current.status.state).toBe("failed")
      expect(current.status.message.parts).toEqual([{ kind: "text", text: "Failed" }])
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

    await runAs("alice", async () => {
      await createAnchor(firstTaskId, contextId)
      await saveMessages(firstTaskId, contextId, [new AIMessage("First response")])
      await createAnchor(secondTaskId, contextId)
      await saveMessages(secondTaskId, contextId, [new AIMessage("Second response")])

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
