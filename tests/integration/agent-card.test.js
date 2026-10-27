import path from "node:path"
import cds from "@sap/cds"
const { GET } = cds.test(import.meta.dirname + "/../projects/bookshop")

describe("@cap-js/agents - Agent Card Generation", () => {
  // ── Agentify mode (CDS model) ────────────────────────────────────────

  describe("Agentify mode (CDS model)", () => {
    it("agent card generated from CDS entities and actions", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("CatalogService")
      expect(card.skills).toHaveLength(14)

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).toBeDefined()
      expect(querySkill.name).toBe("Data Query")
      expect(querySkill.description).toBe(
        "Query data from the service. Available entities: \n Books: Book details with author information \n ListOfBooks: Browse available books \n Authors: Pseudonymized authors of the books on offer",
      )
      expect(querySkill.examples).toEqual(["Show me all Books"])
      expect(querySkill.tags).toEqual(["query", "data", "read", "books", "listofbooks", "authors"])

      const submitSkill = card.skills.find((s) => s.id === "submitOrder")
      expect(submitSkill).toBeDefined()
      expect(submitSkill.name).toBe("submitOrder")
      expect(submitSkill.description).toBe("Submit an order for a book")
      expect(submitSkill.examples).toEqual(["Order 2 copies of Wuthering Heights"])
      expect(submitSkill.tags).toEqual(["submitorder", "action", "hitl"])
    })

    it("capabilities.streaming is true (bookshop default config)", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data
      expect(card.capabilities.streaming).toBe(true)
    })

    it("agent card matches snapshot", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data
      // Strip dynamic URLs (runtime derives them from the request).
      delete card.url
      if (card.additionalInterfaces) {
        for (const iface of card.additionalInterfaces) delete iface.url
      }
      const snapshotPath = path.join(import.meta.dirname, "__snapshots__", "agent-card.json")
      await expect(JSON.stringify(card, null, 2) + "\n").toMatchFileSnapshot(snapshotPath)
    })
  })

  // ── @agent.card annotation (explicit file path override) ────────────────

  describe("@agent.card annotation (explicit file override)", () => {
    it("agent card loaded from @agent.card markdown file", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("custom-book-agent")
      expect(card.description).toBe("A custom book recommendation agent with hand-crafted skills.")
      expect(card.version).toBe("2.0.0")
    })

    it("skills come from the markdown file frontmatter", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      expect(card.skills).toHaveLength(2)

      const recSkill = card.skills.find((s) => s.id === "book-recommendations")
      expect(recSkill).toBeDefined()
      expect(recSkill.name).toBe("Book Recommendations")
      expect(recSkill.description).toBe("Get personalized book recommendations based on genre or mood.")
      expect(recSkill.tags).toEqual(["books", "recommendations", "reading"])
      expect(recSkill.examples).toEqual([
        "Recommend a mystery novel",
        "What should I read next?",
        "Suggest something for a rainy day",
      ])

      const listSkill = card.skills.find((s) => s.id === "reading-list")
      expect(listSkill).toBeDefined()
      expect(listSkill.name).toBe("Reading List Management")
      expect(listSkill.description).toBe("Track books you want to read, are reading, or have finished.")
      expect(listSkill.tags).toEqual(["books", "lists", "tracking"])
      expect(listSkill.examples).toEqual([
        "Add Wuthering Heights to my reading list",
        "What books am I currently reading?",
        "Mark Dune as finished",
      ])
    })

    it("overrides CDS-generated card (no auto query skill)", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).toBeUndefined()
    })
  })

  // ── X-Forwarded-Proto (cloud proxy protocol) ────────────────────────────

  describe("X-Forwarded-Proto header", () => {
    it("agent card URL uses https when X-Forwarded-Proto: https is set", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/catalog/.well-known/agent-card.json", {
        headers: { "x-forwarded-proto": "https" },
      })
      const card = res.data
      expect(card.url).toMatch(/^https:\/\//)
      expect(card.additionalInterfaces[0].url).toMatch(/^https:\/\//)
    })

    it("agent card URL handles multi-value X-Forwarded-Proto", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/catalog/.well-known/agent-card.json", {
        headers: { "x-forwarded-proto": "https, http" },
      })
      const card = res.data
      expect(card.url).toMatch(/^https:\/\//)
    })
  })

  // ── Proxy URL from @Core.Links rel=via ──────────────────────────────────

  describe("Proxy URL from @Core.Links rel=via", () => {
    it("agent card URL uses @Core.Links via href as proxy URL", async () => {
      const res = await GET("/a2a/circuit-breaker/.well-known/agent-card.json")
      const card = res.data

      expect(card.url).toBe("https://example.com/agent/circuit-breaker")
      expect(card.additionalInterfaces[0].url).toBe("https://example.com/agent/circuit-breaker")
    })

    it("agent card without @Core.Links via still uses request-derived URL", async () => {
      // TODO: Review AI Test
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data

      expect(card.url).toContain("/a2a/catalog")
      expect(card.url).not.toContain("example.com")
    })

    it("compile to agent uses the hostUrl option when given", () => {
      const card = cds.compile.to.a2a(cds.model, {
        service: "CircuitBreakerService",
        hostUrl: "https://my.host.com/",
        as: "json",
      })

      expect(card.url).toBe("https://my.host.com/a2a/circuit-breaker")
    })

  })
})
