import cds from "@sap/cds"

const { GET, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")

// Non-2xx responses must resolve (not throw) so we can assert on status codes.
axios.defaults.validateStatus = () => true

const ALICE = { username: "alice", password: "" }

describe("@cap-js/agents - Preview auth challenge (dev-only)", () => {
  it("anonymous GET /preview on service with entity-level @restrict returns 401 with Basic challenge", async () => {
    // EntityRestrictService: no service-level @requires, but entity SecretBooks
    // is @restrict-ed. Anonymous callers must be prompted to authenticate.
    const res = await GET("/a2a/entity-restrict/preview/")
    expect(res.status).toBe(401)
    expect(res.headers["www-authenticate"] ?? "").toMatch(
      /Basic realm="cap-agents:EntityRestrictService"/,
    )
  })

  it("anonymous GET /preview on service with action-level @requires returns 401 with Basic challenge", async () => {
    // CatalogService: no service-level @requires, but submitOrder action carries
    // @requires: ['authenticated-user']. The bookshop-style scenario that
    // motivated this middleware — silent HITL loop under a partially-gated agent.
    const res = await GET("/a2a/catalog/preview/")
    expect(res.status).toBe(401)
    expect(res.headers["www-authenticate"] ?? "").toMatch(/Basic realm="cap-agents:CatalogService"/)
  })

  it("authenticated GET /preview on a service with inner auth returns the preview HTML (200)", async () => {
    const res = await GET("/a2a/entity-restrict/preview/", { auth: ALICE })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"] ?? "").toMatch(/text\/html/)
    // Chat preview renders the agent name into the template.
    expect(res.data).toMatch(/EntityRestrictService/)
  })

  it("anonymous GET /preview on a fully-open service returns 200 (no inner auth to protect)", async () => {
    // GraphBookService: no @requires/@restrict anywhere. Anonymous is fine, no challenge.
    const res = await GET("/a2a/graph-book/preview/")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"] ?? "").toMatch(/text\/html/)
  })

  it("service-level @requires still owns the challenge (no double-hit, existing gate wins)", async () => {
    // RestrictedAgentService has @requires: 'admin' on the service. The outer
    // gate at lib/index.js:52-118 emits 401 with realm="Users" already. Our
    // preview middleware must not interfere or override that.
    const res = await GET("/a2a/restricted-agent/preview")
    expect(res.status).toBe(401)
    expect(res.headers["www-authenticate"] ?? "").toMatch(/Basic realm="Users"/)
  })
})
