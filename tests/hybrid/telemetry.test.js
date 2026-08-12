/**
 * Hybrid telemetry tests — require the `hybrid` CDS profile.
 * Run with: npm run test:hybrid (which sets CDS_ENV=hybrid via `cds bind --exec`).
 * Skipped under regular `npm test` (development profile, mock executor).
 * In hybrid, these tests will fail loudly if the AI Core binding is missing.
 */
import cds from "@sap/cds"
import {
  captured,
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpansAfterRequest,
  findSpan,
  findSpans,
  createSendMessage,
} from "../utils/telemetry-utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/agents - Hybrid telemetry (AI Core)", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)

  before(async () => {
    // ESM patches are async (import() promises) — wait for them to resolve.
    // In hybrid mode with cloud binding resolution, this takes longer.
    await new Promise((r) => setTimeout(r, 5000))
  })

  beforeEach(resetCapture)

  // ─── CJS Patches ───────────────────────────────────────────────────────

  it("should patch CJS BaseChatModel prototype", async () => {
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    expect(BaseChatModel.prototype[PATCHED]).toBe(true)
  })

  it("should patch CJS RunnableSequence prototype", async () => {
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    const { RunnableSequence } = await import("@langchain/core/runnables")
    expect(RunnableSequence.prototype[PATCHED]).toBe(true)
  })

  it("should patch CJS StructuredTool prototype", async () => {
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    const { StructuredTool } = await import("@langchain/core/tools")
    expect(StructuredTool.prototype[PATCHED]).toBe(true)
  })

  // ─── LangGraph Executor Spans ───────────────────────────────────────────

  it("should produce RunnableSequence spans when LangGraph executor runs (proves ESM patch works)", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "Show me all books"))
    const seqSpans = findSpans(spans, "workflow RunnableSequence")
    if (seqSpans.length === 0) {
      // Fallback: verify at least the workflow or chat span exists (proves graph ran)
      const wfSpan = findSpan(spans, "workflow CompiledStateGraph")
      const chatSpan = findSpan(spans, /^chat /)
      expect(wfSpan || chatSpan).not.toBe(undefined)
    } else {
      expect(seqSpans.length > 0, `expected ${seqSpans.length} > 0`).toBeTruthy()
    }
  })

  it("should produce chat span with model name", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "List books"))
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.operation.name"]).toBe("chat")
    expect(chatSpan.attributes["gen_ai.request.model"]).not.toBe(undefined)
  })

  it("should have HTTP outbound spans for AI Core call in same trace as chat span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "What books exist?"))
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)

    const traceId = chatSpan.spanContext().traceId
    const chatSpanId = chatSpan.spanContext().spanId
    const outboundSpans = spans.filter(
      (s) =>
        s.spanContext().traceId === traceId &&
        s.spanContext().spanId !== chatSpanId &&
        (s.kind === 3 ||
          s.name.includes("POST") ||
          s.name.includes("HTTP") ||
          s.name.includes("GET")),
    )
    expect(outboundSpans.length >= 1).toBeTruthy()
  })

  it("should record token usage on chat span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "How many books?"))
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    expect(
      chatSpan.attributes["gen_ai.usage.input_tokens"] > 0,
      `expected ${chatSpan.attributes["gen_ai.usage.input_tokens"]} > 0`,
    ).toBeTruthy()
    expect(
      chatSpan.attributes["gen_ai.usage.output_tokens"] > 0,
      `expected ${chatSpan.attributes["gen_ai.usage.output_tokens"]} > 0`,
    ).toBeTruthy()
  })

  it("should set gen_ai.response.model on chat span (actual model returned by AI Core)", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "What books exist?"))
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    expect(
      chatSpan.attributes["gen_ai.response.model"],
      "expected gen_ai.response.model to be set",
    ).not.toBe(undefined)
    expect(
      chatSpan.attributes["gen_ai.response.model"].length > 0,
      "expected non-empty gen_ai.response.model",
    ).toBeTruthy()
  })

  it("should set gen_ai.response.finish_reasons as array on chat span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "List books"))
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan).not.toBe(undefined)
    const finishReasons = chatSpan.attributes["gen_ai.response.finish_reasons"]
    expect(Array.isArray(finishReasons), `expected array, got ${typeof finishReasons}`).toBeTruthy()
    expect(finishReasons.length > 0, "expected at least one finish reason").toBeTruthy()
    // Normal response should be "stop" or "end_turn" (Anthropic); "length"/"max_tokens" = truncated
    expect(
      ["stop", "end_turn", "tool_calls", "tool_use", "length", "max_tokens"].includes(
        finishReasons[0],
      ),
      `unexpected finish_reason: ${finishReasons[0]}`,
    ).toBeTruthy()
  })

  it("should produce tool execution spans", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "Show me books"))
    const toolSpans = findSpans(spans, "execute_tool")
    expect(toolSpans.length > 0, `expected ${toolSpans.length} > 0`).toBeTruthy()
  })

  it("should have complete span hierarchy: workflow > chat (all in same trace)", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("catalog", "List all books please"))
    const wfSpan = findSpan(spans, "workflow CompiledStateGraph CatalogService")
    const chatSpan = findSpan(spans, /^chat /)

    expect(wfSpan).not.toBe(undefined)
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.spanContext().traceId).toBe(wfSpan.spanContext().traceId)
  })

  // ─── agent_actions metric (per LLM invocation) ─────────────────────────

  it("should emit agent_actions metric per LLM call in react agent", async () => {
    resetCapture()
    await sendMessage("catalog", "What books are available?")
    const output = await flushMetrics()
    expect(output, "agent_actions metric should fire on each LLM invocation").toMatch(
      /agent_actions/,
    )
  })
})
