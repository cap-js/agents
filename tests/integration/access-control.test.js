import assert from "node:assert/strict"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")

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

describe("@cap-js/agent - Access Control", () => {
  describe("Tasks", () => {
    it("bob cannot access alice's task via tasks/get", async () => {
      // Alice creates a task
      const aliceRes = await sendMessageAs("catalog", "What books?", ALICE)
      assert.strictEqual(aliceRes.data.result.status.state, "completed")
      const aliceTaskId = aliceRes.data.result.id

      // Alice can retrieve her own task
      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, ALICE)
      assert.notStrictEqual(aliceGet.data.result, undefined)
      assert.strictEqual(aliceGet.data.result.id, aliceTaskId)

      // Bob cannot retrieve Alice's task
      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, BOB)
      assert.notStrictEqual(bobGet.data.error, undefined)
    })

    it("alice cannot access bob's task via tasks/get", async () => {
      // Bob creates a task
      const bobRes = await sendMessageAs("catalog", "What books?", BOB)
      assert.strictEqual(bobRes.data.result.status.state, "completed")
      const bobTaskId = bobRes.data.result.id

      // Bob can retrieve his own task
      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, BOB)
      assert.notStrictEqual(bobGet.data.result, undefined)
      assert.strictEqual(bobGet.data.result.id, bobTaskId)

      // Alice cannot retrieve Bob's task
      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, ALICE)
      assert.notStrictEqual(aliceGet.data.error, undefined)
    })
  })

  const isMock = !cds.env.profiles?.includes("hybrid")
  const describeCheckpoints = isMock ? describe : describe.skip

  describeCheckpoints("Checkpoints", () => {
    it("bob cannot resume alice's conversation", async () => {
      const contextId = `ac-test-${Date.now()}`

      // Alice starts a conversation that triggers HITL
      const aliceRes = await sendMessageAs("catalog", "I need hitl approval", ALICE, { contextId })
      assert.strictEqual(aliceRes.data.result.status.state, "input-required")
      const taskId = aliceRes.data.result.id

      // Bob tries to resume Alice's HITL task — should fail (checkpoint not found for bob)
      const bobResume = await sendMessageAs("catalog", "yes", BOB, { taskId })
      // Bob either gets an error or a new task (not Alice's resumed task)
      if (bobResume.data.error) {
        assert.notStrictEqual(bobResume.data.error, undefined)
      } else {
        // If SDK creates a new task instead, it won't be Alice's task
        assert.notStrictEqual(bobResume.data.result.id, taskId)
      }
    })

    it("alice can resume her own conversation", async () => {
      const contextId = `ac-test-own-${Date.now()}`

      // Alice starts a HITL conversation
      const aliceRes = await sendMessageAs("catalog", "hitl please", ALICE, { contextId })
      assert.strictEqual(aliceRes.data.result.status.state, "input-required")
      const taskId = aliceRes.data.result.id

      // Alice resumes her own task
      const aliceResume = await sendMessageAs("catalog", "yes", ALICE, { taskId })
      assert.strictEqual(aliceResume.data.result.id, taskId)
      assert.strictEqual(aliceResume.data.result.status.state, "completed")
    })
  })
})
