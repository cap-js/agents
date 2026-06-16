import assert from "node:assert/strict"
import cds from "@sap/cds"
const { GET } = cds.test(import.meta.dirname + "/../samples/bookshop")

describe("@cap-js/agent plugin", () => {
  it("should register agent protocol adapter", () => {
    assert.notStrictEqual(cds.env.protocols.agent, undefined)
    assert.strictEqual(cds.env.protocols.agent.path, "/a2a")
  })

  it("should expose CatalogService with agent endpoint", () => {
    const srv = cds.services.CatalogService
    assert.notStrictEqual(srv, undefined)
    const agentEndpoint = srv.endpoints?.find((ep) => ep.kind === "agent")
    assert.notStrictEqual(agentEndpoint, undefined)
  })

  it("should NOT expose AdminService (no @agent annotation)", () => {
    const srv = cds.services.AdminService
    assert.notStrictEqual(srv, undefined)
    const agentEndpoint = srv.endpoints?.find((ep) => ep.kind === "agent")
    assert.strictEqual(agentEndpoint, undefined)
  })

  it("should still serve OData normally", async () => {
    const { data } = await GET("/odata/v4/catalog/Books")
    assert.notStrictEqual(data.value, undefined)
    assert.ok(data.value.length > 0)
  })
})
