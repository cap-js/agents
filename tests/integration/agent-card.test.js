import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import cds from "@sap/cds"
const { GET } = cds.test(import.meta.dirname + "/../samples/bookshop")

describe("@cap-js/agents - Agent Card Generation", () => {
  // ── Agentify mode (CDS model) ────────────────────────────────────────

  describe("Agentify mode (CDS model)", () => {
    it("agent card generated from CDS entities and actions", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")

      const card = res.data
      assert.strictEqual(card.name, "CatalogService")
      assert.ok(card.skills.length > 0, `expected skills.length > 0`)

      const querySkill = card.skills.find((s) => s.id === "query")
      assert.notStrictEqual(querySkill, undefined)
      assert.strictEqual(querySkill.name, "Data Query")
      assert.ok(querySkill.tags.includes("query"))

      const submitSkill = card.skills.find((s) => s.id === "submitOrder")
      assert.notStrictEqual(submitSkill, undefined)
    })

    it("capabilities.streaming reflects cds.env.agent.streaming config", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data
      assert.strictEqual(card.capabilities.streaming, true)
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
      const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
      assert.deepStrictEqual(card, expected)
    })
  })

  // ── @agent.card annotation (explicit file path override) ────────────────

  describe("@agent.card annotation (explicit file override)", () => {
    it("agent card loaded from @agent.card markdown file", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")

      const card = res.data
      assert.strictEqual(card.name, "custom-book-agent")
      assert.ok(card.description.includes("book recommendation"))
      assert.strictEqual(card.version, "2.0.0")
    })

    it("skills come from the markdown file frontmatter", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      assert.strictEqual(card.skills.length, 2)

      const recSkill = card.skills.find((s) => s.id === "book-recommendations")
      assert.notStrictEqual(recSkill, undefined)
      assert.strictEqual(recSkill.name, "Book Recommendations")
      assert.ok(recSkill.description.includes("personalized"))
      assert.ok(recSkill.tags.includes("books"))
      assert.ok(recSkill.examples.includes("Recommend a mystery novel"))

      const listSkill = card.skills.find((s) => s.id === "reading-list")
      assert.notStrictEqual(listSkill, undefined)
      assert.ok(listSkill.tags.includes("tracking"))
    })

    it("overrides CDS-generated card (no auto query skill)", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      const querySkill = card.skills.find((s) => s.id === "query")
      assert.strictEqual(querySkill, undefined)
    })
  })

  // ── Proxy URL from @Core.Links rel=via ──────────────────────────────────

  describe("Proxy URL from @Core.Links rel=via", () => {
    it("agent card URL uses @Core.Links via href as proxy URL", async () => {
      const res = await GET("/a2a/circuit-breaker/.well-known/agent-card.json")
      const card = res.data

      assert.strictEqual(card.url, "https://example.com/agent/circuit-breaker")
      assert.strictEqual(
        card.supportedInterfaces[0].url,
        "https://example.com/agent/circuit-breaker",
      )
    })

    it("agent card without @Core.Links via still uses request-derived URL", async () => {
      const res = await GET("/a2a/catalog/.well-known/agent-card.json")
      const card = res.data

      assert.ok(card.url.includes("/a2a/catalog"), "URL should be request-derived")
      assert.ok(!card.url.includes("example.com"), "URL should NOT be proxy URL")
    })

    it("compile to agent uses @Core.Links via href as URL", () => {
      const card = cds.compile.to.a2a(cds.model, {
        service: "CircuitBreakerService",
        as: "object",
      })

      assert.strictEqual(card.url, "https://example.com/agent/circuit-breaker")
      assert.strictEqual(
        card.supportedInterfaces[0].url,
        "https://example.com/agent/circuit-breaker",
      )
    })

    it("compile to agent without @Core.Links via uses default HOST URL", () => {
      const card = cds.compile.to.a2a(cds.model, {
        service: "CatalogService",
        as: "object",
      })

      assert.ok(card.url.includes("HOST"), "URL should contain HOST placeholder")
      assert.ok(card.url.includes("/a2a/catalog"), "URL should contain service path")
    })
  })
})
