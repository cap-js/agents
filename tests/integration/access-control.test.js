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

describe("@cap-js/agents - Access Control", () => {
  describe("Tasks", () => {
    it("bob cannot access alice's task via tasks/get", async () => {
      const aliceRes = await sendMessageAs("catalog", "What books?", ALICE)
      assert.strictEqual(aliceRes.data.result.status.state, "completed")
      const aliceTaskId = aliceRes.data.result.id

      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, ALICE)
      assert.notStrictEqual(aliceGet.data.result, undefined)
      assert.strictEqual(aliceGet.data.result.id, aliceTaskId)

      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, BOB)
      assert.notStrictEqual(bobGet.data.error, undefined)
    })

    it("alice cannot access bob's task via tasks/get", async () => {
      const bobRes = await sendMessageAs("catalog", "What books?", BOB)
      assert.strictEqual(bobRes.data.result.status.state, "completed")
      const bobTaskId = bobRes.data.result.id

      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, BOB)
      assert.notStrictEqual(bobGet.data.result, undefined)
      assert.strictEqual(bobGet.data.result.id, bobTaskId)

      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, ALICE)
      assert.notStrictEqual(aliceGet.data.error, undefined)
    })
  })
})
