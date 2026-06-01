const cds = require("@sap/cds")
const { GET } = cds.test(__dirname + "/../bookshop")

describe("@cap-js/a2a - Agent Card Generation", () => {
  // ── Agentify mode (CDS model) ────────────────────────────────────────

  describe("Agentify mode (CDS model)", () => {
    test("agent card generated from CDS entities and actions", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("CatalogService")
      expect(card.skills.length).toBeGreaterThan(0)

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).toBeDefined()
      expect(querySkill.name).toBe("Data Query")
      expect(querySkill.tags).toContain("query")

      const submitSkill = card.skills.find((s) => s.id === "submitOrder")
      expect(submitSkill).toBeDefined()
    })

    test("agent card matches snapshot", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data
      // Remove dynamic url field before snapshot comparison
      delete card.url
      if (card.supportedInterfaces) {
        for (const iface of card.supportedInterfaces) delete iface.url
      }
      expect(card).toMatchSnapshot()
    })
  })

  // ── agentCardPath mode (explicit file path override) ──────────────────

  describe("agentCardPath mode (explicit file override)", () => {
    test("agent card loaded from agentCardPath markdown file", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("custom-book-agent")
      expect(card.description).toContain("book recommendation")
      expect(card.version).toBe("2.0.0")
    })

    test("skills come from the markdown file frontmatter", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      expect(card.skills).toHaveLength(2)

      const recSkill = card.skills.find((s) => s.id === "book-recommendations")
      expect(recSkill).toBeDefined()
      expect(recSkill.name).toBe("Book Recommendations")
      expect(recSkill.description).toContain("personalized")
      expect(recSkill.tags).toContain("books")
      expect(recSkill.examples).toContain("Recommend a mystery novel")

      const listSkill = card.skills.find((s) => s.id === "reading-list")
      expect(listSkill).toBeDefined()
      expect(listSkill.tags).toContain("tracking")
    })

    test("overrides CDS-generated card (no auto query skill)", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).toBeUndefined()
    })
  })
})
