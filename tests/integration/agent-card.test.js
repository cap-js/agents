const path = require("path")
const cds = require("@sap/cds")

// Load the full plugin (registers compile targets + enables docComment)
require("../../cds-plugin")

const bookshopRoot = path.join(__dirname, "../bookshop")
const expectedCard = require("../bookshop/expected-agent-card.json")

// Strip environment-specific fields for comparison
function normalizeCard(card) {
  const { url, version, supportedInterfaces, ...rest } = card
  return {
    ...rest,
    supportedInterfaces: supportedInterfaces?.map(({ url, ...iface }) => iface),
  }
}

describe("@cap-js/a2a - Agent Card", () => {
  describe("compile-time (cds compile -2 a2a)", () => {
    let csn

    beforeAll(async () => {
      cds.root = bookshopRoot
      csn = await cds.load(path.join(bookshopRoot, "srv"))
    })

    test("compiles CatalogService to expected Agent Card", () => {
      const card = cds.compile.to.a2a(csn, { service: "CatalogService", as: "obj" })
      expect(card).toEqual(expectedCard)
    })

    test("throws when multiple services and no -s option", () => {
      expect(() => cds.compile.to.a2a(csn)).toThrow("multiple service")
    })

    test("throws for unknown service name", () => {
      expect(() => cds.compile.to.a2a(csn, { service: "NonExistent" })).toThrow("NonExistent")
    })
  })

  describe("runtime (GET /.well-known/agent-card.json)", () => {
    const { GET } = cds.test(__dirname + "/../bookshop")

    test("serves Agent Card matching expected output", async () => {
      const { status, data: card } = await GET("/a2a/catalog/.well-known/agent-card.json")
      expect(status).toBe(200)
      expect(normalizeCard(card)).toEqual(normalizeCard(expectedCard))
    })

    test("Agent Card has dynamic URL from request", async () => {
      const { data: card } = await GET("/a2a/catalog/.well-known/agent-card.json")
      expect(card.url).toContain("/a2a/catalog")
      expect(card.url).toMatch(/^http/)
      expect(card.supportedInterfaces[0].url).toBe(card.url)
    })

    test("Agent Card has a version", async () => {
      const { data: card } = await GET("/a2a/catalog/.well-known/agent-card.json")
      expect(card.version).toBeDefined()
    })
  })
})
