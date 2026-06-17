import assert from "node:assert/strict"
import cds from "@sap/cds"
import { resolveModelName } from "../../srv/llm.js"

let canLoadDeepAgent = true
try {
  await import("deepagents")
} catch {
  canLoadDeepAgent = false
}

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/deep-agent")
import createHelpers from "../utils/helpers.js"
const { sendMessage } = createHelpers({ POST, axios })

// Mock executor (default in CDS_ENV=test) returns a recognisable string when
// querying the first entity in a service. Used as the negative signal: if the
// auto-deepagent path is taken, the response will NOT match this.
const MOCK_EXECUTOR_TEXT = /Here is a sample from|No data found\.|Could not query data/

// ── @agent.model annotation (per-service LLM override) ─────────────────────
// Independent of the `deepagents` package — exercises only resolveModelName().

describe("@cap-js/agents - @agent.model annotation", () => {
  it("annotation overrides cds.env.agents.llm for the annotated service", () => {
    const srv = cds.services.LlmOverrideService
    assert.ok(srv, "LlmOverrideService should be loaded")

    const annotated = srv.definition["@agent.model"]
    assert.strictEqual(annotated, "test-only--annotated-model")

    // Sanity: the global config is set to a different model in package.json
    assert.notStrictEqual(cds.env.agents.llm, annotated)

    // Resolution: annotation wins over cds.env.agents.llm
    assert.strictEqual(resolveModelName(srv), "test-only--annotated-model")
  })

  it("falls back to cds.env.agents.llm when service has no @agent.model annotation", () => {
    const srv = cds.services.ProductAgentService
    assert.ok(srv, "ProductAgentService should be loaded")

    assert.strictEqual(srv.definition["@agent.model"], undefined)
    assert.ok(cds.env.agents?.llm, "cds.env.agents.llm must be set for this test to be meaningful")
    assert.strictEqual(resolveModelName(srv), cds.env.agents.llm)
  })
})

describe(
  "@cap-js/agents - Auto-built deep agents (zero-code convention)",
  { skip: !canLoadDeepAgent },
  () => {
    // ── Slug-only convention (no .js handler at all) ──────────────────────

    describe("Slug-only convention (zero-code-agent)", () => {
      it("agent card auto-generated from <slug>/AGENTS.md + skills/", async () => {
        const res = await axios.get("/a2a/zero-code-agent/.well-known/agent-card.json")
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.data.name, "zero-code-agent")
        assert.ok(
          res.data.skills.find((s) => s.id === "product-listing"),
          "skills/ scan should yield product-listing",
        )
      })

      it("message/send routes through the auto-deepagent (not the mock executor)", async () => {
        const res = await sendMessage("zero-code-agent", "Hi")
        const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
        assert.doesNotMatch(
          text,
          MOCK_EXECUTOR_TEXT,
          `mock executor response received — auto-deepagent wiring failed: ${text}`,
        )
      })
    })

    // ── @agent.directory annotation override ────────────────────────────────

    describe("@agent.directory annotation (override-card-service)", () => {
      it("agent card resolved from annotation-pointed dir + @agent.card file", async () => {
        const res = await axios.get("/a2a/override-card/.well-known/agent-card.json")
        assert.strictEqual(res.status, 200)
        // @agent.card wins over the in-dir resolution chain.
        assert.strictEqual(res.data.name, "card-override-explicit")
        assert.strictEqual(res.data.version, "2.0.0")
      })

      it("message/send routes through auto-deepagent (annotation-resolved dir)", async () => {
        const res = await sendMessage("override-card", "Hi")
        const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
        assert.doesNotMatch(
          text,
          MOCK_EXECUTOR_TEXT,
          `mock executor response received — @agent.directory wiring failed: ${text}`,
        )
      })
    })

    // ── Tool override path (product-agent: minimal handler) ───────────────

    describe("Tool override path (product-agent)", () => {
      it("auto-built deepagent includes both auto-generated CDS tools and the user's custom tool", async () => {
        const { resolveTools } = await import("../../srv/tools.js")
        const srv = cds.services.ProductAgentService
        assert.ok(srv, "ProductAgentService should be loaded")

        const { tools, toolMap } = await resolveTools(srv)
        const names = tools.map((t) => t.name)
        assert.ok(
          names.includes("calculate_bulk_pricing"),
          `custom tool missing — got: ${names.join(", ")}`,
        )
        assert.ok(
          names.some((n) => /order|describe|query|Products/i.test(n)),
          `auto-generated CDS tools missing — got: ${names.join(", ")}`,
        )
        assert.strictEqual(
          toolMap.calculate_bulk_pricing,
          tools.find((t) => t.name === "calculate_bulk_pricing"),
        )
      })

      it("message/send routes through the auto-deepagent (not the mock executor)", async () => {
        const res = await sendMessage("product-agent", "Hi")
        const text = res.data.result?.status?.message?.parts?.[0]?.text ?? ""
        assert.doesNotMatch(
          text,
          MOCK_EXECUTOR_TEXT,
          `mock executor response received — product-agent wiring failed: ${text}`,
        )
      })
    })
  },
)
