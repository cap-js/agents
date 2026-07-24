import cds from "@sap/cds"
import assert from "node:assert/strict"

const { GET } = cds.test(import.meta.dirname + "/../samples/deep-agent")

describe("@cap-js/agents - Agent Card (deep agent modes)", () => {
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

  // ── @agent.directory annotation (override slug-based agent dir) ─────────

  it("@agent.directory annotation: agent card built from the annotation-resolved agent dir", async () => {
    // DirOverrideService has @agent.directory but NO @agent.card, so card
    // generation is forced through the dir resolution chain (AGENTS.md
    // frontmatter + skills/ scan).
    const res = await GET("/a2a/dir-override/.well-known/agent-card.json")
    const card = res.data
    // From `card-override-agent/AGENTS.md` frontmatter:
    assert.strictEqual(card.name, "card-override-agent")
    assert.ok(card.description.includes("Read-only product browsing"))
    // From `card-override-agent/skills/product-overview/SKILL.md`:
    const skill = card.skills.find((s) => s.id === "product-overview")
    assert.notStrictEqual(skill, undefined, "skills/ scan should yield product-overview")
    assert.ok(skill.tags.includes("products"))
  })

  // ── @agent.card annotation (explicit card markdown file) ────────────────

  it("@agent.card annotation loads card from a markdown file outside the agent directory", async () => {
    const res = await GET("/a2a/override-card/.well-known/agent-card.json")
    const card = res.data

    // From `cards/card-override.md` frontmatter (NOT from the agent dir):
    assert.strictEqual(card.name, "card-override-explicit")
    assert.strictEqual(card.version, "2.0.0")
    const skill = card.skills.find((s) => s.id === "catalog-browse")
    assert.notStrictEqual(skill, undefined, "card should expose @agent.card skill")
    assert.ok(skill.tags.includes("override"))
  })

  // ── Slug-only convention (zero-code service) ──────────────────────────
  it("Slug-only convention: agent card auto-built from <slug>/AGENTS.md + skills/", async () => {
    const res = await GET("/a2a/zero-code-agent/.well-known/agent-card.json")
    const card = res.data
    assert.strictEqual(card.name, "zero-code-agent")
    assert.ok(card.description.includes("product catalog"))

    const listing = card.skills.find((s) => s.id === "product-listing")
    assert.notStrictEqual(listing, undefined, "skills/ scan should yield product-listing skill")
    assert.ok(listing.tags.includes("read-only"))
  })

  // ── Co-located convention (AGENTS.md next to service.cds) ─────────────
  it("Co-located convention: AGENTS.md in srcDir is picked up without a dedicated sub-directory", async () => {
    const res = await GET("/a2a/colocated-agent/.well-known/agent-card.json")
    const card = res.data
    assert.strictEqual(card.name, "colocated-agent")
    assert.ok(card.description.includes("Co-located agent"))

    const browse = card.skills.find((s) => s.id === "product-browse")
    assert.notStrictEqual(browse, undefined, "skills/ scan should yield product-browse skill")
    assert.ok(browse.tags.includes("read-only"))
  })
})
