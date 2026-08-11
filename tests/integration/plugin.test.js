import cds from "@sap/cds"
const { GET } = cds.test(import.meta.dirname + "/../samples/bookshop")

describe("@cap-js/agents plugin", () => {
  it("should register agent protocol adapter", () => {
    expect(cds.env.protocols.agent).not.toBe(undefined)
    expect(cds.env.protocols.agent.path).toBe("/a2a")
  })

  it("should expose CatalogService with agent endpoint", () => {
    const srv = cds.services.CatalogService
    expect(srv).not.toBe(undefined)
    const agentEndpoint = srv.endpoints?.find((ep) => ep.kind === "agent")
    expect(agentEndpoint).not.toBe(undefined)
  })

  it("should still serve OData normally", async () => {
    const { data } = await GET("/odata/v4/catalog/Books")
    expect(data.value).not.toBe(undefined)
    expect(data.value.length > 0).toBeTruthy()
  })

  it("should serve the preview UI for @agent services", async () => {
    const res = await GET("/a2a/catalog/preview")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.data.includes("CatalogService")).toBeTruthy()
  })
})
