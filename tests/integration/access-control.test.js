import cds from "@sap/cds"
const { GET, POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")

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

    it("bob cannot update alice's task via message/send with her taskId", async () => {
      // Alice creates a task
      const aliceRes = await sendMessageAs("catalog", "List books", ALICE)
      expect(aliceRes.data.result.status.state).toBe("completed")
      const aliceTaskId = aliceRes.data.result.id

      // Bob tries to send a message targeting alice's taskId
      const bobRes = await sendMessageAs("catalog", "Override!", BOB, { taskId: aliceTaskId })

      // Alice's task must remain unchanged (bob's update should not affect it)
      const aliceGet = await jsonrpcAs("catalog", "tasks/get", { id: aliceTaskId }, ALICE)
      expect(aliceGet.data.result).not.toBe(undefined)
      expect(aliceGet.data.result.status.message.parts[0].text).not.toMatch(/Override/)
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

  // ─── @restrict enforcement on service level ──────────────────────────────

  describe("@restrict enforcement", () => {
    // Helper to build a fresh anonymous message/send envelope for a service.
    function anonSend(service, text = "hi") {
      return POST(`/a2a/${service}/`, {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text }],
          },
        },
      })
    }

    // ── @restrict without `to` — profile-conditional env fallback ─────
    //   dev  → public   (env fallback inactive; annotation extracts no roles)
    //   prod → 401 for anonymous  (restrict_all_services fallback fires)

    describe("@restrict without `to`", () => {
      it("should allow anonymous POST in dev (falls through to env fallback, which is inactive)", async () => {
        const res = await anonSend("restrict-no-to")
        expect(res.status).toBe(200)
        expect(res.data.result).not.toBe(undefined)
        expect(res.data.result.status.state).toBe("completed")
        expect(res.data.result.status.message.parts[0].text).toMatch(/NoTo echo/)
      })

      it("should allow any authenticated user to POST message (no role required)", async () => {
        const res = await sendMessageAs("restrict-no-to", "hello", BOB)
        expect(res.status).toBe(200)
        expect(res.data.result).not.toBe(undefined)
        expect(res.data.result.status.state).toBe("completed")
        expect(res.data.result.status.message.parts[0].text).toMatch(/NoTo echo/)
      })
    })

    // ── @restrict without `to` in prod mode ───────────────────────────

    describe("@restrict without `to` — prod-mode env fallback", () => {
      let savedNodeEnv
      let savedRestrictAll
      let restrictAllWasSet

      beforeAll(() => {
        savedNodeEnv = process.env.NODE_ENV
        process.env.NODE_ENV = "production"
        cds.env.requires ??= {}
        cds.env.requires.auth ??= {}
        restrictAllWasSet = "restrict_all_services" in cds.env.requires.auth
        savedRestrictAll = cds.env.requires.auth.restrict_all_services
        cds.env.requires.auth.restrict_all_services = true
      })

      afterAll(() => {
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = savedNodeEnv
        if (restrictAllWasSet) cds.env.requires.auth.restrict_all_services = savedRestrictAll
        else delete cds.env.requires.auth.restrict_all_services
      })

      it("should return 401 for anonymous POST in prod mode", async () => {
        const res = await anonSend("restrict-no-to")
        expect(res.status).toBe(401)
        expect(res.data.jsonrpc).toBe("2.0")
        expect(res.data.error.code).toBe(-32001)
        expect(res.data.error.message).toMatch(/Unauthorized/)
      })

      it("should still allow authenticated user (BOB) in prod mode", async () => {
        const res = await sendMessageAs("restrict-no-to", "hello", BOB)
        expect(res.status).toBe(200)
        expect(res.data.result.status.state).toBe("completed")
        expect(res.data.result.status.message.parts[0].text).toMatch(/NoTo echo/)
      })
    })

    // ── @restrict with `to: 'any'` — explicit public pseudo-role ──────

    describe("@restrict with `to: 'any'`", () => {
      it("should allow anonymous POST (truly public)", async () => {
        const res = await anonSend("restrict-any")
        expect(res.status).toBe(200)
        expect(res.data.result).not.toBe(undefined)
        expect(res.data.result.status.state).toBe("completed")
        expect(res.data.result.status.message.parts[0].text).toMatch(/Any echo/)
      })
    })

    // ── @restrict with `to: 'admin'` — parity with @requires: 'admin' ─

    describe("@restrict with `to: 'admin'`", () => {
      it("should return 401 for anonymous POST", async () => {
        const res = await anonSend("restrict-admin")
        expect(res.status).toBe(401)
        expect(res.data.error.code).toBe(-32001)
      })

      it("should return 403 for authenticated user without admin role", async () => {
        const res = await sendMessageAs("restrict-admin", "hi", BOB)
        expect(res.status).toBe(403)
        expect(res.data.error.code).toBe(-32003)
        expect(res.data.error.message).toBe("Forbidden")
      })

      it("should allow user with admin role to POST", async () => {
        const res = await sendMessageAs("restrict-admin", "hi admin", ALICE)
        expect(res.status).toBe(200)
        expect(res.data.result.status.state).toBe("completed")
        expect(res.data.result.status.message.parts[0].text).toMatch(/AdminRestrict echo/)
      })
    })
  })

  // ─── @restrict enforcement on entity level ───────────────────────────────

  describe("@restrict enforcement on entity level", () => {
    it("alice (admin) can read @restrict-protected entity via tool call", async () => {
      const res = await sendMessageAs("entity-restrict", "list books", ALICE)
      expect(res.status).toBe(200)
      expect(res.data.result.status.state).toBe("completed")
      // Mock LLM queries the only entity in the service; SecretBooks is in alice's schema
      // so the tool result — echoed back in the response — contains the sentinel value
      const text = res.data.result.status.message.parts[0].text
      expect(text, `expected sentinel in response, got: ${text}`).toMatch(/ADMIN_ONLY_SENTINEL/)
    })

    it("bob (no admin role) cannot read @restrict-protected entity via tool call", async () => {
      const res = await sendMessageAs("entity-restrict", "list books", BOB)
      expect(res.status).toBe(200)
      expect(res.data.result.status.state).toBe("completed")
      // SecretBooks is filtered from bob's tool schema — no tool call is made,
      // so the sentinel value must never appear in the response
      const text = res.data.result.status.message.parts[0].text
      expect(text, `sentinel must not leak to bob, got: ${text}`).not.toMatch(/ADMIN_ONLY_SENTINEL/)
    })
  })
})
