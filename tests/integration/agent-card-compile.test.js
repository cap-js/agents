import cds from "@sap/cds"

const { GET } = cds.test(import.meta.dirname + "/../projects/agent-card-compile")

describe("@cap-js/agents - agent card compilation", () => {

  describe("when the service has only a .cds file with annotations", () => {

    it("should use the service name as the card name", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")
      expect(card.name).toBe("PlainCdsService")
    })

    it("should expose a query skill whose description carries the entity @description", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")
      const query = card.skills.find((s) => s.id === "query")
      expect(query).toBeDefined()
      expect(query.description).toContain("Books available in the catalog.")
      expect(query.tags).toContain("books")
    })

    it("should expose an action skill when the service declares an action", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")
      const reserve = card.skills.find((s) => s.tags.includes("reserve"))
      expect(reserve).toBeDefined()
    })
  })

  describe("when the service has a co-located AGENTS.md and skills", () => {

    it("should override the card name, version, and description from the AGENTS.md frontmatter", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")
      expect(card.name).toBe("shop-assistant")
      expect(card.version).toBe("3.1.0")
      expect(card.description).toBe("A hand-written assistant for the shop.")
    })

    it("should append a scanned skill when a public SKILL.md is present", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")
      const lookup = card.skills.find((s) => s.id === "product-lookup")
      expect(lookup).toBeDefined()
      expect(lookup.name).toBe("Product Lookup")
      expect(lookup.tags).toContain("products")
      expect(lookup.examples).toContain("Show me all products")
    })

    it("should keep the annotation-derived query skill alongside the scanned skills", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")
      expect(card.skills.find((s) => s.id === "query")).toBeDefined()
    })

    it("should exclude a skill when its SKILL.md sets metadata.private", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")
      expect(card.skills.find((s) => s.id === "internal-formatting")).toBeUndefined()
    })
  })

  describe("when @agent.directory points to a sibling folder", () => {

    it("should build the card from the annotated directory when the folder name differs from the slug", async () => {
      // TODO: Review AI Test
      const { data: card } = await GET("/a2a/external-dir/.well-known/agent-card.json")
      expect(card.name).toBe("external-home-agent")
      const lookup = card.skills.find((s) => s.id === "catalog-lookup")
      expect(lookup).toBeDefined()
      expect(lookup.tags).toContain("catalog")
    })
  })
})
