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
      expect(aliceRes.data.result.status.state).toBe("completed")
      const aliceTaskId = aliceRes.data.result.id

      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, ALICE)
      expect(aliceGet.data.result).not.toBe(undefined)
      expect(aliceGet.data.result.id).toBe(aliceTaskId)

      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, BOB)
      expect(bobGet.data.error).not.toBe(undefined)
    })

    it("alice cannot access bob's task via tasks/get", async () => {
      const bobRes = await sendMessageAs("catalog", "What books?", BOB)
      expect(bobRes.data.result.status.state).toBe("completed")
      const bobTaskId = bobRes.data.result.id

      const bobGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, BOB)
      expect(bobGet.data.result).not.toBe(undefined)
      expect(bobGet.data.result.id).toBe(bobTaskId)

      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: bobTaskId }, ALICE)
      expect(aliceGet.data.error).not.toBe(undefined)
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
      expect(res.status).toBe(401)
      expect(res.data.jsonrpc).toBe("2.0")
      expect(res.data.error.code).toBe(-32001)
      expect(res.data.error.message).toMatch(/Unauthorized/)
    })

    it("should return 403 for user without admin role", async () => {
      const res = await sendMessageAs("restricted-agent", "hello", BOB)
      expect(res.status).toBe(403)
      expect(res.data.jsonrpc).toBe("2.0")
      expect(res.data.error.code).toBe(-32003)
      expect(res.data.error.message).toBe("Forbidden")
    })

    it("should allow user with admin role to send message", async () => {
      const res = await sendMessageAs("restricted-agent", "hello admin", ALICE)
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      expect(res.data.result.status.state).toBe("completed")
      expect(res.data.result.status.message.parts[0].text).toMatch(/Admin echo/)
    })

    it("should propagate cds.context.user through agent graph ($user resolves to caller)", async () => {
      const res = await sendMessageAs("restricted-agent", "who am I?", ALICE)
      expect(res.status).toBe(200)
      expect(res.data.result.status.state).toBe("completed")
      const text = res.data.result.status.message.parts[0].text
      // The graph node reads cds.context.user.id and executes a CDS query with it
      expect(text, `expected user=alice in response, got: ${text}`).toMatch(/user=alice/)
      expect(text, `expected query_ran=true in response, got: ${text}`).toMatch(/query_ran=true/)
    })

    it("should return 401 for anonymous GET to agent card of restricted service", async () => {
      const res = await GET("/a2a/restricted-agent/.well-known/agent-card.json")
      expect(res.status).toBe(401)
    })

    it("should include WWW-Authenticate header on anonymous GET 401 to trigger browser credential dialog", async () => {
      const res = await GET("/a2a/restricted-agent/.well-known/agent-card.json")
      expect(res.status).toBe(401)
      expect(
        res.headers["www-authenticate"] ?? "",
        "Expected WWW-Authenticate: Basic realm=... to prompt browser login dialog",
      ).toMatch(/Basic realm=/)
    })

    it("should include WWW-Authenticate header on anonymous GET to preview of restricted service", async () => {
      const res = await GET("/a2a/restricted-agent/preview")
      expect(res.status).toBe(401)
      expect(
        res.headers["www-authenticate"] ?? "",
        "Expected WWW-Authenticate: Basic realm=... to prompt browser login dialog",
      ).toMatch(/Basic realm=/)
    })

    it("should allow admin to GET agent card of restricted service", async () => {
      const res = await GET("/a2a/restricted-agent/.well-known/agent-card.json", { auth: ALICE })
      expect(res.status).toBe(200)
      expect(res.data.name).not.toBe(undefined)
    })

    it("should NOT restrict services without @requires in test profile", async () => {
      // catalog service has no @requires — should be accessible without auth
      const res = await sendMessageAs("catalog", "books", BOB)
      expect(res.status).toBe(200)
      expect(res.data.result.status.state).toBe("completed")
    })
  })
})
