import assert from "node:assert/strict"
import cds from "@sap/cds"
const { GET, POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")

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

  // ─── @requires enforcement on A2A endpoint ───────────────────────────

  describe("@requires enforcement", () => {
    it("should return 401 for anonymous POST to restricted service", async () => {
      // No auth header → anonymous user
      const res = await POST("/a2a/restricted-agent/", {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "anon-1",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
      })
      assert.strictEqual(res.status, 401)
      assert.strictEqual(res.data.jsonrpc, "2.0")
      assert.strictEqual(res.data.error.code, -32001)
      assert.match(res.data.error.message, /Unauthorized/)
    })

    it("should return 403 for user without admin role", async () => {
      const res = await sendMessageAs("restricted-agent", "hello", BOB)
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.data.jsonrpc, "2.0")
      assert.strictEqual(res.data.error.code, -32003)
      assert.strictEqual(res.data.error.message, "Forbidden")
    })

    it("should allow user with admin role to send message", async () => {
      const res = await sendMessageAs("restricted-agent", "hello admin", ALICE)
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      assert.strictEqual(res.data.result.status.state, "completed")
      assert.match(res.data.result.status.message.parts[0].text, /Admin echo/)
    })

    it("should propagate cds.context.user through agent graph ($user resolves to caller)", async () => {
      const res = await sendMessageAs("restricted-agent", "who am I?", ALICE)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.data.result.status.state, "completed")
      const text = res.data.result.status.message.parts[0].text
      // The graph node reads cds.context.user.id and executes a CDS query with it
      assert.match(text, /user=alice/, `expected user=alice in response, got: ${text}`)
      assert.match(text, /query_ran=true/, `expected query_ran=true in response, got: ${text}`)
    })

    it("should return 401 for anonymous GET to agent card of restricted service", async () => {
      const res = await GET("/a2a/restricted-agent/.well-known/agent-card.json")
      assert.strictEqual(res.status, 401)
    })

    it("should include WWW-Authenticate header on anonymous GET 401 to trigger browser credential dialog", async () => {
      const res = await GET("/a2a/restricted-agent/.well-known/agent-card.json")
      assert.strictEqual(res.status, 401)
      assert.match(
        res.headers["www-authenticate"] ?? "",
        /Basic realm=/,
        "Expected WWW-Authenticate: Basic realm=... to prompt browser login dialog",
      )
    })

    it("should include WWW-Authenticate header on anonymous GET to preview of restricted service", async () => {
      const res = await GET("/a2a/restricted-agent/preview")
      assert.strictEqual(res.status, 401)
      assert.match(
        res.headers["www-authenticate"] ?? "",
        /Basic realm=/,
        "Expected WWW-Authenticate: Basic realm=... to prompt browser login dialog",
      )
    })

    it("should allow admin to GET agent card of restricted service", async () => {
      const res = await GET("/a2a/restricted-agent/.well-known/agent-card.json", { auth: ALICE })
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.name, undefined)
    })

    it("should NOT restrict services without @requires in test profile", async () => {
      // catalog service has no @requires — should be accessible without auth
      const res = await sendMessageAs("catalog", "books", BOB)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.data.result.status.state, "completed")
    })
  })
})
