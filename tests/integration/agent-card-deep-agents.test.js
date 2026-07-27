import cds from "@sap/cds"

const { GET } = cds.test(import.meta.dirname + "/../samples/deep-agent")

describe("@cap-js/agents - Agent Card (deep agent modes)", () => {
  // ── skills/ directory scan ──────────────────────────────────────────

  describe("skills/ directory scan", () => {
    it("agent card generated from AGENTS.md frontmatter", async () => {
      const res = await GET("/a2a/product-agent/.well-known/agent-card.json")

      const card = res.data
      expect(card.name).toBe("product-agent")
      expect(card.description.includes("Product catalog agent for searching products")).toBeTruthy()
      expect(card.version).toBe("1.0.0")
    })

    it("public skills included, private skills excluded", async () => {
      const res = await GET("/a2a/product-agent/.well-known/agent-card.json")
      const card = res.data

      const searchSkill = card.skills.find((s) => s.id === "product-search")
      expect(searchSkill).not.toBe(undefined)
      expect(searchSkill.name).toBe("Product Search")
      expect(searchSkill.tags.includes("products")).toBeTruthy()
      expect(searchSkill.examples.includes("Show me all products")).toBeTruthy()

      const orderSkill = card.skills.find((s) => s.id === "order-management")
      expect(orderSkill).not.toBe(undefined)

      // response-format has metadata.private: true
      const privateSkill = card.skills.find((s) => s.id === "response-format")
      expect(privateSkill).toBe(undefined)
    })

    it("metadata.tags and metadata.examples in agent card", async () => {
      const res = await GET("/a2a/product-agent/.well-known/agent-card.json")
      const card = res.data

      const orderSkill = card.skills.find((s) => s.id === "order-management")
      expect(orderSkill.tags).toEqual(["orders", "products", "checkout"])
      expect(orderSkill.examples.includes("Order 5 Widget Pro")).toBeTruthy()
      expect(orderSkill.examples.includes("Place an order for 100 Gadget X")).toBeTruthy()
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
    expect(card.name).toBe("card-override-agent")
    expect(card.description.includes("Read-only product browsing")).toBeTruthy()
    // From `card-override-agent/skills/product-overview/SKILL.md`:
    const skill = card.skills.find((s) => s.id === "product-overview")
    expect(skill, "skills/ scan should yield product-overview").not.toBe(undefined)
    expect(skill.tags.includes("products")).toBeTruthy()
  })

  // ── @agent.card annotation (explicit card markdown file) ────────────────

  it("@agent.card annotation loads card from a markdown file outside the agent directory", async () => {
    const res = await GET("/a2a/override-card/.well-known/agent-card.json")
    const card = res.data

    // From `cards/card-override.md` frontmatter (NOT from the agent dir):
    expect(card.name).toBe("card-override-explicit")
    expect(card.version).toBe("2.0.0")
    const skill = card.skills.find((s) => s.id === "catalog-browse")
    expect(skill, "card should expose @agent.card skill").not.toBe(undefined)
    expect(skill.tags.includes("override")).toBeTruthy()
  })

  // ── Slug-only convention (zero-code service) ──────────────────────────
  it("Slug-only convention: agent card auto-built from <slug>/AGENTS.md + skills/", async () => {
    const res = await GET("/a2a/zero-code-agent/.well-known/agent-card.json")
    const card = res.data
    expect(card.name).toBe("zero-code-agent")
    expect(card.description.includes("product catalog")).toBeTruthy()
    const listing = card.skills.find((s) => s.id === "product-listing")
    expect(listing, "skills/ scan should yield product-listing skill").not.toBe(undefined)
    expect(listing.tags.includes("read-only")).toBeTruthy()
  })

  // ── Co-located convention (AGENTS.md next to service.cds) ─────────────
  it("Co-located convention: AGENTS.md in srcDir is picked up without a dedicated sub-directory", async () => {
    const res = await GET("/a2a/colocated-agent/.well-known/agent-card.json")
    const card = res.data
    expect(card.name).toBe("colocated-agent")
    expect(card.description.includes("Co-located agent")).toBeTruthy()
    const browse = card.skills.find((s) => s.id === "product-browse")
    expect(browse, "skills/ scan should yield product-browse skill").not.toBe(undefined)
    expect(browse.tags.includes("read-only")).toBeTruthy()
  })
})
