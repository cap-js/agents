const cds = require("@sap/cds")
const { GET } = cds.test(__dirname + "/../bookshop")

describe("@cap-js/a2a plugin", () => {
  it("should register a2a protocol adapter", () => {
    expect(cds.env.protocols.a2a).toBeDefined()
    expect(cds.env.protocols.a2a.path).toBe("/a2a")
  })

  it("should expose CatalogService with a2a endpoint", () => {
    const srv = cds.services.CatalogService
    expect(srv).toBeDefined()
    const a2aEndpoint = srv.endpoints?.find((ep) => ep.kind === "a2a")
    expect(a2aEndpoint).toBeDefined()
  })

  it("should NOT expose AdminService (no @a2a annotation)", () => {
    const srv = cds.services.AdminService
    expect(srv).toBeDefined()
    const a2aEndpoint = srv.endpoints?.find((ep) => ep.kind === "a2a")
    expect(a2aEndpoint).toBeUndefined()
  })

  it("should still serve OData normally", async () => {
    const { data } = await GET("/odata/v4/catalog/Books")
    expect(data.value).toBeDefined()
    expect(data.value.length).toBeGreaterThan(0)
  })
})
