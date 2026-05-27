const cds = require("@sap/cds")
const { axios } = cds.test(__dirname + "/../bookshop")

describe("@cap-js/a2a - Agent Card Generation", () => {
  // ── Agentify mode (CDS model) ────────────────────────────────────────

  describe("Agentify mode (CDS model)", () => {
    test("agent card generated from CDS entities and actions", async () => {
      const res = await axios.get("/a2a/catalog/.well-known/agent-card.json")
      expect(res.status).toBe(200)

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
      const res = await axios.get("/a2a/catalog/.well-known/agent-card.json")
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
      const res = await axios.get("/a2a/custom-agent-card/.well-known/agent-card.json")
      expect(res.status).toBe(200)

      const card = res.data
      expect(card.name).toBe("custom-book-agent")
      expect(card.description).toContain("book recommendation")
      expect(card.version).toBe("2.0.0")
    })

    test("skills come from the markdown file frontmatter", async () => {
      const res = await axios.get("/a2a/custom-agent-card/.well-known/agent-card.json")
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
      const res = await axios.get("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).toBeUndefined()
    })
  })
})

// ── Deep agent modes (skills/ scan + AGENT_CARD.md convention) ──────────
// These tests require deep-agent-sample which has deepagents ESM deps.
// Skip if deepagents can't be loaded in Jest.

let canLoadDeepAgent = true
try {
  require("deepagents")
} catch {
  canLoadDeepAgent = false
}

const describeDeepAgent = canLoadDeepAgent ? describe : describe.skip

describeDeepAgent("@cap-js/a2a - Agent Card (deep agent modes)", () => {
  const { axios: ax2 } = canLoadDeepAgent ? cds.test(__dirname + "/../deep-agent-sample") : {}

  // ── skills/ directory scan ──────────────────────────────────────────

  describe("skills/ directory scan", () => {
    test("agent card generated from AGENTS.md frontmatter", async () => {
      const res = await ax2.get("/a2a/product-agent/.well-known/agent-card.json")
      expect(res.status).toBe(200)

      const card = res.data
      expect(card.name).toBe("product-agent")
      expect(card.description).toContain("Product catalog agent for searching products")
      expect(card.version).toBe("1.0.0")
    })

    test("public skills included, private skills excluded", async () => {
      const res = await ax2.get("/a2a/product-agent/.well-known/agent-card.json")
      const card = res.data

      const searchSkill = card.skills.find((s) => s.id === "product-search")
      expect(searchSkill).toBeDefined()
      expect(searchSkill.name).toBe("Product Search")
      expect(searchSkill.tags).toContain("products")
      expect(searchSkill.examples).toContain("Show me all products")

      const orderSkill = card.skills.find((s) => s.id === "order-management")
      expect(orderSkill).toBeDefined()

      // response-format has metadata.private: true
      const privateSkill = card.skills.find((s) => s.id === "response-format")
      expect(privateSkill).toBeUndefined()
    })

    test("metadata.tags and metadata.examples in agent card", async () => {
      const res = await ax2.get("/a2a/product-agent/.well-known/agent-card.json")
      const card = res.data

      const orderSkill = card.skills.find((s) => s.id === "order-management")
      expect(orderSkill.tags).toEqual(["orders", "products", "checkout"])
      expect(orderSkill.examples).toContain("Order 5 Widget Pro")
      expect(orderSkill.examples).toContain("Place an order for 100 Gadget X")
    })
  })

  // ── AGENT_CARD.md convention (within agentDir) ────────────────────────

  describe("AGENT_CARD.md convention (within agentDir)", () => {
    test("agent card generated from AGENT_CARD.md in agentDir", async () => {
      const res = await ax2.get("/a2a/custom-agent-card/.well-known/agent-card.json")
      expect(res.status).toBe(200)

      const card = res.data
      expect(card.name).toBe("custom-book-agent")
      expect(card.description).toContain("book recommendation")
      expect(card.version).toBe("2.0.0")
    })

    test("skills come from AGENT_CARD.md frontmatter", async () => {
      const res = await ax2.get("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      expect(card.skills).toHaveLength(2)

      const recSkill = card.skills.find((s) => s.id === "book-recommendations")
      expect(recSkill).toBeDefined()
      expect(recSkill.tags).toContain("books")
      expect(recSkill.examples).toContain("Recommend a mystery novel")
    })

    test("skills/ directory is ignored when AGENT_CARD.md exists", async () => {
      const res = await ax2.get("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      // Only skills from AGENT_CARD.md
      expect(card.skills.map((s) => s.id).sort()).toEqual(["book-recommendations", "reading-list"])

      // skills/ directory contents (book-formatting, library-helpers) are NOT in the card
      expect(card.skills.find((s) => s.id === "book-formatting")).toBeUndefined()
      expect(card.skills.find((s) => s.id === "library-helpers")).toBeUndefined()
    })
  })
})
