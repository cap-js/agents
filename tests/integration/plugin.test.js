import assert from "node:assert/strict"
import cds from "@sap/cds"
const { GET } = cds.test(import.meta.dirname + "/../bookshop")

describe("@cap-js/a2a plugin", () => {
  it("should register a2a protocol adapter", () => {
    assert.notStrictEqual(cds.env.protocols.a2a, undefined)
    assert.strictEqual(cds.env.protocols.a2a.path, "/a2a")
  })

  it("should expose CatalogService with a2a endpoint", () => {
    const srv = cds.services.CatalogService
    assert.notStrictEqual(srv, undefined)
    const a2aEndpoint = srv.endpoints?.find((ep) => ep.kind === "a2a")
    assert.notStrictEqual(a2aEndpoint, undefined)
  })

  it("should NOT expose AdminService (no @a2a annotation)", () => {
    const srv = cds.services.AdminService
    assert.notStrictEqual(srv, undefined)
    const a2aEndpoint = srv.endpoints?.find((ep) => ep.kind === "a2a")
    assert.strictEqual(a2aEndpoint, undefined)
  })

  it("should still serve OData normally", async () => {
    const { data } = await GET("/odata/v4/catalog/Books")
    assert.notStrictEqual(data.value, undefined)
    assert.ok(data.value.length > 0)
  })
})
