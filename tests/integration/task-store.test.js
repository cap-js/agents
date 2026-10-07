import cds from "@sap/cds"
cds.test(import.meta.dirname + "/../projects/bookshop")
import { ensureTaskAnchor } from "../../lib/protocol/persistence/message-store.js"
import { CdsTaskStore, PERSIST_TASK } from "../../lib/protocol/persistence/task-store.js"

const MESSAGES = "cap.agent.Messages"

function runAs(userId, fn) {
  return cds.tx({ user: new cds.User({ id: userId }) }, fn)
}

function task(id, state, artifacts) {
  return {
    id,
    contextId: `context-${id}`,
    kind: "task",
    status: { state, [PERSIST_TASK]: true },
    artifacts,
  }
}

async function createAnchor(taskId) {
  await ensureTaskAnchor({
    taskId,
    contextId: `context-${taskId}`,
    message: { kind: "message", messageId: taskId, role: "user", parts: [] },
    agentService: "TestService",
  })
}

describe("CdsTaskStore", () => {
  it("ignores unmarked SDK saves even when the accumulated task state is durable", async () => {
    const store = new CdsTaskStore()
    const taskId = `task-${cds.utils.uuid()}`

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await store.save({ ...task(taskId, "submitted"), status: { state: "submitted" } })
    })

    const row = await SELECT.one.from(MESSAGES).where({ ID: taskId, createdBy: "alice" })
    expect(row.role).toBe("user")
  })

  it("persists durable lifecycle on the initiating message only", async () => {
    const store = new CdsTaskStore()
    const taskId = `task-${cds.utils.uuid()}`

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await store.save(task(taskId, "submitted"))
      await store.save(
        task(taskId, "working", [
          { artifactId: "thinking-0", parts: [{ kind: "text", text: "private reasoning" }] },
        ]),
      )

      const current = await store.load(taskId)
      expect(current.status.state).toBe("submitted")
    })

    const row = await SELECT.one.from(MESSAGES).where({ ID: taskId, createdBy: "alice" })
    expect(row.role).toBe("user")
    expect(row.session).toBe(`context-${taskId}`)
    expect(await SELECT.from(MESSAGES).where({ session: row.session })).toHaveLength(1)
  })

  it("persists input-required state without thinking artifacts", async () => {
    const store = new CdsTaskStore()
    const taskId = `task-${cds.utils.uuid()}`

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await store.save(task(taskId, "submitted"))
      await store.save(
        task(taskId, "input-required", [
          { artifactId: "thinking-0", parts: [{ kind: "text", text: "private reasoning" }] },
          { artifactId: "response", parts: [{ kind: "text", text: "Approve?" }] },
        ]),
      )
    })

    const rows = await SELECT.from(MESSAGES)
      .where({ session: `context-${taskId}`, createdBy: "alice" })
      .orderBy("sequence")
    expect(rows.at(-1).role).toBe("hitl")
    expect(rows.at(-1).type).toBe("request")
  })

  it("isolates database reads by user", async () => {
    const store = new CdsTaskStore()
    const taskId = `task-${cds.utils.uuid()}`

    await runAs("alice", async () => {
      await createAnchor(taskId)
      await store.save(task(taskId, "submitted"))
    })

    await runAs("bob", async () => {
      expect(await store.load(taskId)).toBe(undefined)
    })
  })
})
