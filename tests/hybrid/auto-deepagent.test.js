import cds from "@sap/cds"

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/deep-agent")
import createHelpers from "../utils/helpers.js"
const { sendMessage } = createHelpers({ POST, axios })

// Mock executor (default in CDS_ENV=test) returns a recognisable string when
// querying the first entity in a service. Used as the negative signal: if the
// auto-deepagent path is taken, the response will NOT match this.
const MOCK_EXECUTOR_TEXT = /\[Mock LLM\]|Here is a sample from|No data found\.|Could not query data/

// ── @agent.llm annotation (per-service LLM override) ─────────────────────
// Exercises model resolution via buildModel event — annotation wins over global config.

describe("@cap-js/agents - @agent.llm annotation", () => {
  it("annotation overrides cds.env.agents.llm for the annotated service", async () => {
    const srv = cds.services.LlmOverrideService
    expect(srv, "LlmOverrideService should be loaded").toBeTruthy()

    const annotated = srv.definition["@agent.llm"]
    expect(annotated).toBe("llm2")

    // Sanity: the global config is set to a different model in package.json
    expect(annotated).not.toBe("llm")

    // Resolution via buildModel: model connected to annotated provider name
    const model = await srv.send("buildModel", { srv })
    expect(model, "buildModel should return a model").toBeTruthy()
    expect(model.name).toBe(annotated)
    expect(model.options.message).toBe("[Mock LLM2] Override for testing")
  })

  it("falls back to default llm service when service has no @agent.llm annotation", async () => {
    const srv = cds.services.ProductAgentService
    expect(srv, "ProductAgentService should be loaded").toBeTruthy()

    expect(srv.definition["@agent.llm"]).toBe(undefined)

    const model = await srv.send("buildModel", { srv })
    expect(model, "buildModel should return a model").toBeTruthy()
    expect(model.name).toBe("llm")
    const resolvedName = model.orchestrationConfig?.promptTemplating?.model?.name
    expect(resolvedName).toBe(cds.requires.llm.modelName)
  })
})

describe("@cap-js/agents - Auto-built deep agents (zero-code convention)", () => {
  // ── Slug-only convention (no .js handler at all) ──────────────────────

  describe("Slug-only convention (zero-code-agent)", () => {
    it("agent card auto-generated from <slug>/AGENTS.md + skills/", async () => {
      const res = await axios.get("/a2a/zero-code-agent/.well-known/agent-card.json")
      expect(res.status).toBe(200)
      expect(res.data.name).toBe("zero-code-agent")
      expect(
        res.data.skills.find((s) => s.id === "product-listing"),
        "skills/ scan should yield product-listing",
      ).toBeTruthy()
    })

    it("message/send routes through the auto-deepagent (not the mock executor)", async () => {
      const res = await sendMessage("zero-code-agent", "Hi")
      const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
      expect(
        text,
        `mock executor response received — auto-deepagent wiring failed: ${text}`,
      ).not.toMatch(MOCK_EXECUTOR_TEXT)
    })
  })

  // ── @agent.directory annotation override ────────────────────────────────

  describe("@agent.directory annotation (override-card-service)", () => {
    it("agent card resolved from annotation-pointed dir + @agent.card file", async () => {
      const res = await axios.get("/a2a/override-card/.well-known/agent-card.json")
      expect(res.status).toBe(200)
      // @agent.card wins over the in-dir resolution chain.
      expect(res.data.name).toBe("card-override-explicit")
      expect(res.data.version).toBe("2.0.0")
    })

    it("message/send routes through auto-deepagent (annotation-resolved dir)", async () => {
      const res = await sendMessage("override-card", "Hi")
      const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
      expect(
        text,
        `mock executor response received — @agent.directory wiring failed: ${text}`,
      ).not.toMatch(MOCK_EXECUTOR_TEXT)
    })
  })

  // ── Tool override path (product-agent: minimal handler) ───────────────

  describe("Tool override path (product-agent)", () => {
    it("auto-built deepagent includes both auto-generated CDS tools and the user's custom tool", async () => {
      const srv = cds.services.ProductAgentService
      expect(srv, "ProductAgentService should be loaded").toBeTruthy()

      // Dispatch buildTools event — app handler extends default tools with custom tool
      const tools = await srv.send("buildTools")
      const names = tools.map((t) => t.name)
      expect(
        names.includes("calculate_bulk_pricing"),
        `custom tool missing — got: ${names.join(", ")}`,
      ).toBeTruthy()
      expect(
        names.some((n) => /order|describe|query|Products/i.test(n)),
        `auto-generated CDS tools missing — got: ${names.join(", ")}`,
      ).toBeTruthy()
    })

    it("message/send routes through the auto-deepagent (not the mock executor)", async () => {
      const res = await sendMessage("product-agent", "Hi")
      const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
      expect(
        text,
        `mock executor response received — product-agent wiring failed: ${text}`,
      ).not.toMatch(MOCK_EXECUTOR_TEXT)
    })
  })
})
