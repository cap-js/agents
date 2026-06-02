import assert from "node:assert/strict"
import cds from "@sap/cds"

let canLoadDeepAgent = true
try {
  await import("deepagents")
} catch {
  canLoadDeepAgent = false
}

const { GET } = cds.test(import.meta.dirname + "/../deep-agent-sample")

// ── Deep agent modes (skills/ scan + AGENT_CARD.md convention) ──────────
// These tests require deep-agent-sample which has deepagents ESM deps.
// Skip if deepagents can't be loaded.

describe("@cap-js/a2a - Agent Card (deep agent modes)", { skip: !canLoadDeepAgent }, () => {
  // ── skills/ directory scan ──────────────────────────────────────────

  describe("skills/ directory scan", () => {
    it("agent card generated from AGENTS.md frontmatter", async () => {
      const res = await GET("/a2a/product-agent/.well-known/agent-card.json")

      const card = res.data
      assert.strictEqual(card.name, "product-agent")
      assert.ok(card.description.includes("Product catalog agent for searching products"))
      assert.strictEqual(card.version, "1.0.0")
    })

    it("public skills included, private skills excluded", async () => {
      const res = await GET("/a2a/product-agent/.well-known/agent-card.json")
      const card = res.data

      const searchSkill = card.skills.find((s) => s.id === "product-search")
      assert.notStrictEqual(searchSkill, undefined)
      assert.strictEqual(searchSkill.name, "Product Search")
      assert.ok(searchSkill.tags.includes("products"))
      assert.ok(searchSkill.examples.includes("Show me all products"))

      const orderSkill = card.skills.find((s) => s.id === "order-management")
      assert.notStrictEqual(orderSkill, undefined)

      // response-format has metadata.private: true
      const privateSkill = card.skills.find((s) => s.id === "response-format")
      assert.strictEqual(privateSkill, undefined)
    })

    it("metadata.tags and metadata.examples in agent card", async () => {
      const res = await GET("/a2a/product-agent/.well-known/agent-card.json")
      const card = res.data

      const orderSkill = card.skills.find((s) => s.id === "order-management")
      assert.deepStrictEqual(orderSkill.tags, ["orders", "products", "checkout"])
      assert.ok(orderSkill.examples.includes("Order 5 Widget Pro"))
      assert.ok(orderSkill.examples.includes("Place an order for 100 Gadget X"))
    })
  })

  // ── AGENT_CARD.md convention (within agentDir) ────────────────────────

  describe("AGENT_CARD.md convention (within agentDir)", () => {
    it("agent card generated from AGENT_CARD.md in agentDir", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")

      const card = res.data
      assert.strictEqual(card.name, "custom-book-agent")
      assert.ok(card.description.includes("book recommendation"))
      assert.strictEqual(card.version, "2.0.0")
    })

    it("skills come from AGENT_CARD.md frontmatter", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      assert.strictEqual(card.skills.length, 2)

      const recSkill = card.skills.find((s) => s.id === "book-recommendations")
      assert.notStrictEqual(recSkill, undefined)
      assert.ok(recSkill.tags.includes("books"))
      assert.ok(recSkill.examples.includes("Recommend a mystery novel"))
    })

    it("skills/ directory is ignored when AGENT_CARD.md exists", async () => {
      const res = await GET("/a2a/custom-agent-card/.well-known/agent-card.json")
      const card = res.data

      // Only skills from AGENT_CARD.md
      assert.deepStrictEqual(card.skills.map((s) => s.id).sort(), [
        "book-recommendations",
        "reading-list",
      ])

      // skills/ directory contents (book-formatting, library-helpers) are NOT in the card
      assert.strictEqual(
        card.skills.find((s) => s.id === "book-formatting"),
        undefined,
      )
      assert.strictEqual(
        card.skills.find((s) => s.id === "library-helpers"),
        undefined,
      )
    })
  })
})
