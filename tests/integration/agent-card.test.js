import path from "node:path"
import cds from "@sap/cds"
const { GET } = cds.test(import.meta.dirname + "/../projects/bookshop")

describe("@cap-js/agents - Agent Card Generation", () => {
  // ── Agentify mode (CDS model) ────────────────────────────────────────

  describe("Agentify mode (CDS model)", () => {
    it("agent card generated from CDS entities and actions", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("CatalogService")
      expect(card.skills.length > 0, `expected skills.length > 0`).toBeTruthy()

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).not.toBe(undefined)
      expect(querySkill.name).toBe("Data Query")
      expect(querySkill.tags.includes("query")).toBeTruthy()
      const submitSkill = card.skills.find((s) => s.id === "submitOrder")
      expect(submitSkill).not.toBe(undefined)
    })

    it("capabilities.streaming reflects cds.env.agents.streaming config", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data
      expect(card.capabilities.streaming).toBe(true)
    })

    it("agent card matches snapshot", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data
      // Strip dynamic placeholder URLs (compile uses "https://HOST/..." vs
      // runtime's request-derived URL).
      delete card.url
      if (card.supportedInterfaces) {
        for (const iface of card.supportedInterfaces) delete iface.url
      }
      const snapshotPath = path.join(import.meta.dirname, "__snapshots__", "agent-card.json")
      await expect(card).toMatchFileSnapshot(snapshotPath)
    })
  })

  // ── @agent.card annotation (explicit file path override) ────────────────

  describe("@agent.card annotation (explicit file override)", () => {
    it("agent card loaded from @agent.card markdown file", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("custom-book-agent")
      expect(card.description.includes("book recommendation")).toBeTruthy()
      expect(card.version).toBe("2.0.0")
    })

    it("skills come from the markdown file frontmatter", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      expect(card.skills.length).toBe(2)

      const recSkill = card.skills.find((s) => s.id === "book-recommendations")
      expect(recSkill).not.toBe(undefined)
      expect(recSkill.name).toBe("Book Recommendations")
      expect(recSkill.description.includes("personalized")).toBeTruthy()
      expect(recSkill.tags.includes("books")).toBeTruthy()
      expect(recSkill.examples.includes("Recommend a mystery novel")).toBeTruthy()

      const listSkill = card.skills.find((s) => s.id === "reading-list")
      expect(listSkill).not.toBe(undefined)
      expect(listSkill.tags.includes("tracking")).toBeTruthy()
    })

    it("overrides CDS-generated card (no auto query skill)", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      const querySkill = card.skills.find((s) => s.id === "query")
      expect(querySkill).toBe(undefined)
    })
  })

  // ── X-Forwarded-Proto (cloud proxy protocol) ────────────────────────────

  describe("X-Forwarded-Proto header", () => {
    it("agent card URL uses https when X-Forwarded-Proto: https is set", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json", {
        headers: { "x-forwarded-proto": "https" },
      })
      const card = res.data
      expect(card.url.startsWith("https://")).toBeTruthy()
      expect(card.supportedInterfaces[0].url.startsWith("https://")).toBeTruthy()
    })

    it("agent card URL handles multi-value X-Forwarded-Proto", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json", {
        headers: { "x-forwarded-proto": "https, http" },
      })
      const card = res.data
      expect(card.url.startsWith("https://")).toBeTruthy()
    })
  })

  // ── Proxy URL from @Core.Links rel=via ──────────────────────────────────

  describe("Proxy URL from @Core.Links rel=via", () => {
    it("agent card URL uses @Core.Links via href as proxy URL", async () => {
      const res = await GET("/a2a/circuit-breaker/.well-known/agent-card.json")
      const card = res.data

      expect(card.url).toBe("https://example.com/agent/circuit-breaker")
      expect(card.supportedInterfaces[0].url).toBe("https://example.com/agent/circuit-breaker")
    })

    it("agent card without @Core.Links via still uses request-derived URL", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data

      expect(card.url.includes("/a2a/catalog"), "URL should be request-derived").toBeTruthy()
      expect(!card.url.includes("example.com"), "URL should NOT be proxy URL").toBeTruthy()
    })

    it("compile to agent uses @Core.Links via href as URL", () => {
      const card = cds.compile.to.a2a(cds.model, {
        service: "CircuitBreakerService",
        as: "object",
      })

      expect(card.url).toBe("https://example.com/agent/circuit-breaker")
      expect(card.supportedInterfaces[0].url).toBe("https://example.com/agent/circuit-breaker")
    })

    it("compile to agent without @Core.Links via uses default HOST URL", () => {
      const card = cds.compile.to.a2a(cds.model, {
        service: "CatalogService",
        as: "object",
      })

      expect(card.url.includes("HOST"), "URL should contain HOST placeholder").toBeTruthy()
      expect(card.url.includes("/a2a/catalog"), "URL should contain service path").toBeTruthy()
    })
  })
})
