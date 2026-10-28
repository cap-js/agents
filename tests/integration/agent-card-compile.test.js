import cds from "@sap/cds"

const { GET } = cds.test(import.meta.dirname + "/../projects/agent-card-compile")

describe("agent card compilation", () => {
  describe("when the service has only a .cds file with annotations", () => {
    it("should use the service name as the card name", async () => {
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")
      expect(card.name).toBe("PlainCdsService")
    })

    it("should successfully aggregate the required query skill based on available entities", async () => {
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")

      expect(card.skills.map((s) => s.id)).toEqual(["query", "annotatedAction", "plainFunction"])

      const query = card.skills.find((s) => s.id === "query")
      expect(query.description).toContain("- FirstSimpleEntity: The first simple entity.")
      expect(query.description).toContain("- SecondSimpleEntity: The second simple entity.")
      expect(query.tags).toEqual([
        "query",
        "data",
        "read",
        "firstsimpleentity",
        "secondsimpleentity",
      ])
    })

    it("should successfully aggregate an action skill from the action name, @description, doc, and kind", async () => {
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")

      const callActionSkill = card.skills.find((s) => s.id === "annotatedAction")
      expect(callActionSkill).toBeDefined()
      expect(callActionSkill.name).toBe("annotatedAction")
      expect(callActionSkill.description).toBe("The annotated action.")
      expect(callActionSkill.examples).toEqual(["run the annotated action", "trigger it twice"])
      expect(callActionSkill.tags).toEqual(["annotatedaction", "action", "hitl"])
    })

    it("should apply defaults when aggregating a function skill when no metadata is configured in annotations", async () => {
      const { data: card } = await GET("/a2a/plain-cds/.well-known/agent-card.json")

      const callFunctionSkill = card.skills.find((s) => s.id === "plainFunction")
      expect(callFunctionSkill).toBeDefined()
      expect(callFunctionSkill.name).toBe("plainFunction")
      expect(callFunctionSkill.description).toBe("Get plainFunction")
      expect(callFunctionSkill.examples).toEqual(["Get plainFunction"])
      expect(callFunctionSkill.tags).toEqual(["plainfunction", "function"])
    })
  })

  describe("when the service has a co-located AGENTS.md and skills files", () => {
    it("should override the card name, version, and description from the AGENTS.md frontmatter", async () => {
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")

      expect(card.name).toBe("shop-assistant")
      expect(card.version).toBe("3.1.0")
      expect(card.description).toBe("A hand-written assistant for the shop.")
    })

    it("should append scanned skills while keeping the generic query and call skills", async () => {
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")

      const lookup = card.skills.find((s) => s.id === "product-lookup")
      expect(lookup).toBeDefined()
      expect(lookup.name).toBe("Product Lookup")
      expect(lookup.tags).toContain("products")
      expect(lookup.examples).toContain("Show me all products")

      expect(card.skills.find((s) => s.id === "query")).toBeDefined()
      expect(card.skills.find((s) => s.id === "serviceAction")).toBeDefined()
    })

    it("should exclude a skill when its SKILL.md sets metadata.private", async () => {
      const { data: card } = await GET("/a2a/with-agents-md/.well-known/agent-card.json")
      expect(card.skills.find((s) => s.id === "internal-formatting")).toBeUndefined()
    })
  })

  describe("when @agent.directory points to a sibling folder", () => {
    it("should build the card from the annotated directory when the folder name differs from the slug", async () => {
      const { data: card } = await GET("/a2a/external-dir/.well-known/agent-card.json")

      expect(card.name).toBe("external-home-agent")
      const lookup = card.skills.find((s) => s.id === "catalog-lookup")
      expect(lookup).toBeDefined()
      expect(lookup.tags).toContain("catalog")
    })

    it("should apply the AGENTS.md frontmatter from the annotated directory", async () => {
      const { data: card } = await GET("/a2a/external-dir/.well-known/agent-card.json")

      expect(card.version).toBe("4.2.0")
      expect(card.description).toBe(
        "An agent whose metadata lives in a directory resolved by @agent.directory.",
      )
    })
  })
})
