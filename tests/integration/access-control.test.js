const cds = require("@sap/cds")
const { POST, axios } = cds.test(__dirname + "/../bookshop")

axios.defaults.validateStatus = () => true

const ALICE = { username: "alice", password: "" }
const BOB = { username: "bob", password: "" }

function jsonrpcAs(service, method, params, auth) {
  return POST(`/a2a/${service}/`, { jsonrpc: "2.0", id: 1, method, params }, { auth })
}

function sendMessageAs(service, text, auth, { contextId, taskId } = {}) {
  return jsonrpcAs(
    service,
    "message/send",
    {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        ...(taskId && { taskId }),
        parts: [{ kind: "text", text }],
      },
    },
    auth,
  )
}

describe("@cap-js/a2a - Access Control", () => {
  describe("Tasks", () => {
    test("bob cannot access alice's task via tasks/get", async () => {
      // Alice creates a task
      const aliceRes = await sendMessageAs("catalog", "What books?", ALICE)
      expect(aliceRes.data.result.status.state).toBe("completed")
      const aliceTaskId = aliceRes.data.result.id

      // Alice can retrieve her own task
      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, ALICE)
      expect(aliceGet.data.result).toBeDefined()
      expect(aliceGet.data.result.id).toBe(aliceTaskId)

      // Bob cannot retrieve Alice's task
      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, BOB)
      expect(bobGet.data.error).toBeDefined()
    })

    test("alice cannot access bob's task via tasks/get", async () => {
      // Bob creates a task
      const bobRes = await sendMessageAs("catalog", "What books?", BOB)
      expect(bobRes.data.result.status.state).toBe("completed")
      const bobTaskId = bobRes.data.result.id

      // Bob can retrieve his own task
      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, BOB)
      expect(bobGet.data.result).toBeDefined()
      expect(bobGet.data.result.id).toBe(bobTaskId)

      // Alice cannot retrieve Bob's task
      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, ALICE)
      expect(aliceGet.data.error).toBeDefined()
    })
  })

  describe("Checkpoints", () => {
    test("bob cannot resume alice's conversation", async () => {
      const contextId = `ac-test-${Date.now()}`

      // Alice starts a conversation that triggers HITL
      const aliceRes = await sendMessageAs("catalog", "I need hitl approval", ALICE, { contextId })
      expect(aliceRes.data.result.status.state).toBe("input-required")
      const taskId = aliceRes.data.result.id

      // Bob tries to resume Alice's HITL task — should fail (checkpoint not found for bob)
      const bobResume = await sendMessageAs("catalog", "yes", BOB, { taskId })
      // Bob either gets an error or a new task (not Alice's resumed task)
      if (bobResume.data.error) {
        expect(bobResume.data.error).toBeDefined()
      } else {
        // If SDK creates a new task instead, it won't be Alice's task
        expect(bobResume.data.result.id).not.toBe(taskId)
      }
    })

    test("alice can resume her own conversation", async () => {
      const contextId = `ac-test-own-${Date.now()}`

      // Alice starts a HITL conversation
      const aliceRes = await sendMessageAs("catalog", "hitl please", ALICE, { contextId })
      expect(aliceRes.data.result.status.state).toBe("input-required")
      const taskId = aliceRes.data.result.id

      // Alice resumes her own task
      const aliceResume = await sendMessageAs("catalog", "yes", ALICE, { taskId })
      expect(aliceResume.data.result.id).toBe(taskId)
      expect(aliceResume.data.result.status.state).toBe("completed")
    })
  })
})
