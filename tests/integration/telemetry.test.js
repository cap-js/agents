import assert from "node:assert/strict"
import cds from "@sap/cds"
import { createMockAICore } from "../utils/mock-ai-core.js"
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
  getSpanExporter,
} from "../utils/telemetry-utils.js"
import createHelpers from "../utils/helpers.js"

// Capture warnings for truncation tests — initialized in before() after cds boots
const warnings = []
let _originalLogWarn

// Start mock AI Core BEFORE cds.test() — needed for circuit-breaker service
const mock = createMockAICore()
const mockPort = await mock.start()
process.env.MOCK_AICORE_PORT = String(mockPort)

// Disable cds.test() console silencing so we can capture telemetry output
process.env.CDS_TEST_SILENT = "false"

// Must be called BEFORE cds.test()
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
const sendMessage = createSendMessage(POST)
const { sendMessage: sendMsgHelper } = createHelpers({ POST, axios })

// Span/metrics tests require [test] profile telemetry config (ConsoleSpanExporter).
// In hybrid mode, telemetry uses different exporters that our in-memory capture can't intercept.
const isHybrid = cds.env.profiles?.includes("hybrid")

describe("@cap-js/agents - OpenTelemetry integration", { skip: isHybrid }, () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  // ─── E2E ────────────────────────────────────────────────────────────

  it("should complete A2A request via graph with MCP tools", async () => {
    const res = await sendMessage("graph-book", "Show me books")
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.result, undefined)
    assert.strictEqual(res.data.result.status.state, "completed")
    assert.match(
      res.data.result.status.message.parts[0].text,
      /Wuthering Heights|Jane Eyre|Catweazle/,
    )
  })

  // ─── Spans ──────────────────────────────────────────────────────────

  it("should create workflow span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "workflow span test"))
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    assert.notStrictEqual(span, undefined)
    assert.strictEqual(span.attributes["gen_ai.operation.name"], "invoke_agent")
    assert.strictEqual(span.attributes["gen_ai.agent.name"], "GraphBookService")
    assert.notStrictEqual(span.attributes["agent.task.id"], undefined)
    assert.notStrictEqual(span.attributes["agent.context.id"], undefined)
    assert.strictEqual(span.attributes["agent.outcome"], "completed")
  })

  it("should create tool span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "tool span test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool query")
    assert.notStrictEqual(span, undefined)
    assert.strictEqual(span.attributes["gen_ai.operation.name"], "execute_tool")
    assert.strictEqual(span.attributes["gen_ai.tool.call.id"], "query")
    assert.strictEqual(span.attributes["gen_ai.tool.call.outcome"], "success")
  })

  it("should create tool span for custom (non-CDS) tools via prototype patch", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "custom tool test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool getBookCount")
    assert.notStrictEqual(span, undefined)
    assert.strictEqual(span.attributes["gen_ai.operation.name"], "execute_tool")
    assert.strictEqual(span.attributes["gen_ai.tool.call.id"], "getBookCount")
    assert.strictEqual(span.attributes["gen_ai.tool.call.outcome"], "success")
  })

  it("should create RunnableSequence spans for graph nodes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "sequence test"))
    const seqSpans = findSpans(spans, "workflow RunnableSequence")
    assert.ok(seqSpans.length > 0, `expected ${seqSpans.length} > 0`)
    const nodeNames = seqSpans.map((s) => s.name)
    assert.strictEqual(
      nodeNames.some((n) => n.includes("llm")),
      true,
    )
    assert.strictEqual(
      nodeNames.some((n) => n.includes("tools")),
      true,
    )
  })

  it("should record tool_calls requested by LLM on chat span", async () => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")

    // Create a mock model that returns tool_calls
    class MockModelWithTools extends BaseChatModel {
      _llmType() {
        return "mock"
      }
      async _generate(messages) {
        const msg = new AIMessage({
          content: "",
          tool_calls: [
            { name: "query", args: { entity: "Books" }, id: "call-1" },
            { name: "getStock", args: { book: 201 }, id: "call-2" },
          ],
        })
        return { generations: [{ message: msg }] }
      }
    }

    const model = new MockModelWithTools({})
    const exporter = await getSpanExporter()
    exporter.reset()

    // Invoke triggers the monkey-patched BaseChatModel.invoke
    await model.invoke([new HumanMessage("test")])

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, "chat MockModelWithTools")
    assert.notStrictEqual(chatSpan, undefined)
    assert.notStrictEqual(chatSpan.attributes["gen_ai.response.tool_calls"], undefined)
    const toolCalls = JSON.parse(chatSpan.attributes["gen_ai.response.tool_calls"])
    assert.strictEqual(toolCalls.length, 2)
    assert.strictEqual(toolCalls[0].name, "query")
    assert.strictEqual(toolCalls[1].name, "getStock")
  })

  it("should NOT include input/output content at default log level", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "privacy test"))
    for (const span of spans) {
      assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined)
      assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined)
    }
  })

  it("should nest spans: tool is descendant of workflow", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "hierarchy test"))
    const wfSpan = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")

    assert.notStrictEqual(wfSpan, undefined)
    assert.notStrictEqual(toolSpan, undefined)

    assert.strictEqual(toolSpan.spanContext().traceId, wfSpan.spanContext().traceId)
    const toolParent = spans.find((s) => s.spanContext().spanId === toolSpan.parentSpanId)
    const isDirectChild = toolSpan.parentSpanId === wfSpan.spanContext().spanId
    const isGrandchild = toolParent?.parentSpanId === wfSpan.spanContext().spanId
    assert.strictEqual(isDirectChild || isGrandchild, true)
  })

  // ─── Monkey-patching ────────────────────────────────────────────────

  it("should have LangChain patches applied (feature flag default on)", async () => {
    assert.notStrictEqual(cds.env.agents.trace_langchain, false)
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    assert.strictEqual(BaseChatModel.prototype[PATCHED], true)
  })

  it("should patch StructuredTool.invoke", async () => {
    const { StructuredTool } = await import("@langchain/core/tools")
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    assert.strictEqual(StructuredTool.prototype[PATCHED], true)
  })

  it("should patch RunnableLambda.invoke", async () => {
    const { RunnableLambda } = await import("@langchain/core/runnables")
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    assert.strictEqual(RunnableLambda.prototype[PATCHED], true)
  })

  // ─── Metrics ────────────────────────────────────────────────────────

  it("should record golden signal metrics", async () => {
    await sendMessage("graph-book", "Metrics test")
    const output = await flushMetrics()
    assert.match(output, /agent\.requests\.total/)
    assert.match(output, /agent\.request\.duration/)
    assert.match(output, /agent\.workflows\.completed/)
    assert.match(output, /agent_actions/)
    assert.match(output, /agent\.tool\.invocations/)
    assert.match(output, /sap\.tenantId/)
  })

  it("should record LLM metrics (tokens, invocations)", async () => {
    await sendMessage("graph-book", "LLM test")
    const output = await flushMetrics()
    assert.match(output, /agent\.llm\.input_tokens/)
    assert.match(output, /agent\.llm\.output_tokens/)
    assert.match(output, /agent\.llm\.invocations/)
    assert.match(output, /mock-model-for-testing/)
  })

  // ─── Correlation ────────────────────────────────────────────────────

  it("should register cls_custom_fields for A2A correlation", () => {
    const cls_fields = cds.env.log.cls_custom_fields
    assert.notStrictEqual(cls_fields, undefined)
    assert.ok(cls_fields.includes("agent.task.id"))
    assert.ok(cls_fields.includes("agent.context.id"))
  })

  it("should set A2A correlation IDs on responses", async () => {
    const res = await sendMessage("graph-book", "Correlation test")
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.result.id, undefined)
    assert.ok(res.data.result.id.length > 0, `expected ${res.data.result.id.length} > 0`)
    assert.notStrictEqual(res.data.result.contextId, undefined)
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenAI Semantic Convention compliance tests (uses mock AI Core)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("@cap-js/agents - GenAI Semantic Conventions", { skip: isHybrid }, () => {
  axios.defaults.validateStatus = () => true

  let originalQuota
  before(() => {
    originalQuota = cds.env.agents.pool.maxTasksPerHourPerUser
    cds.env.agents.pool.maxTasksPerHourPerUser = 200
    // Intercept cds.log("agent").warn after cds is fully bootstrapped
    const LOG = cds.log("agent")
    _originalLogWarn = LOG.warn.bind(LOG)
    LOG.warn = function (...args) {
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
      warnings.push(msg)
      _originalLogWarn(...args)
    }
  })
  after(() => {
    cds.env.agents.pool.maxTasksPerHourPerUser = originalQuota
    mock.stop()
    const LOG = cds.log("agent")
    if (_originalLogWarn) LOG.warn = _originalLogWarn
  })
  beforeEach(() => {
    mock.resetCallCount()
    mock.setStatus(200)
    mock.setFinishReason("stop")
    mock.setModel("mock-gpt-4")
    mock.setReasoningTokens(null)
    warnings.length = 0
    resetCapture()
  })

  // ─── gen_ai.response.model ─────────────────────────────────────────────

  it("should set gen_ai.response.model from AI Core response", async () => {
    mock.setModel("gpt-4-turbo-2024-04-09")
    const exporter = await getSpanExporter()
    exporter.reset()

    await sendMsgHelper("circuit-breaker", "model name test")

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, /^chat /)
    assert.notStrictEqual(chatSpan, undefined, "expected chat span")
    assert.strictEqual(chatSpan.attributes["gen_ai.response.model"], "gpt-4-turbo-2024-04-09")
  })

  it("should set gen_ai.response.model on BaseChatModel patch path", async () => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")

    class ModelWithResponseModel extends BaseChatModel {
      _llmType() {
        return "mock-response-model"
      }
      async _generate() {
        const msg = new AIMessage({
          content: "Hello",
          response_metadata: { model_name: "claude-4-sonnet-20250514", id: "resp-001" },
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        })
        return { generations: [{ message: msg }] }
      }
    }

    const model = new ModelWithResponseModel({})
    const exporter = await getSpanExporter()
    exporter.reset()

    await model.invoke([new HumanMessage("test")])

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, "chat ModelWithResponseModel")
    assert.notStrictEqual(chatSpan, undefined)
    assert.strictEqual(chatSpan.attributes["gen_ai.response.model"], "claude-4-sonnet-20250514")
  })

  // ─── gen_ai.response.finish_reasons ────────────────────────────────────

  it("should set gen_ai.response.finish_reasons as array (normal stop)", async () => {
    mock.setFinishReason("stop")
    const exporter = await getSpanExporter()
    exporter.reset()

    await sendMsgHelper("circuit-breaker", "normal response")

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, /^chat /)
    assert.notStrictEqual(chatSpan, undefined)
    assert.deepStrictEqual(chatSpan.attributes["gen_ai.response.finish_reasons"], ["stop"])
    assert.strictEqual(chatSpan.attributes["gen_ai.response.truncated"], undefined)
  })

  it("should warn and set truncated when finish_reason is 'length'", async () => {
    mock.setFinishReason("length")
    const exporter = await getSpanExporter()
    exporter.reset()

    await sendMsgHelper("circuit-breaker", "truncated response")

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, /^chat /)
    assert.notStrictEqual(chatSpan, undefined)
    assert.deepStrictEqual(chatSpan.attributes["gen_ai.response.finish_reasons"], ["length"])
    assert.strictEqual(chatSpan.attributes["gen_ai.response.truncated"], true)

    const truncWarn = warnings.find((w) => w.includes("truncated"))
    assert.notStrictEqual(truncWarn, undefined, "expected truncation warning")
    assert.match(truncWarn, /max_tokens/)
  })

  it("should warn and set truncated when finish_reason is 'max_tokens' (Anthropic)", async () => {
    mock.setFinishReason("max_tokens")
    const exporter = await getSpanExporter()
    exporter.reset()

    await sendMsgHelper("circuit-breaker", "anthropic truncated")

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, /^chat /)
    assert.notStrictEqual(chatSpan, undefined)
    assert.deepStrictEqual(chatSpan.attributes["gen_ai.response.finish_reasons"], ["max_tokens"])
    assert.strictEqual(chatSpan.attributes["gen_ai.response.truncated"], true)
  })

  it("should detect truncation via BaseChatModel patch", async () => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")

    class TruncatedMockModel extends BaseChatModel {
      _llmType() {
        return "mock-truncated"
      }
      async _generate() {
        const msg = new AIMessage({
          content: "Cut off at max tok",
          response_metadata: { finish_reason: "length", id: "resp-trunc-001" },
          usage_metadata: { input_tokens: 100, output_tokens: 4096, total_tokens: 4196 },
        })
        return { generations: [{ message: msg }] }
      }
    }

    const model = new TruncatedMockModel({})
    const exporter = await getSpanExporter()
    exporter.reset()
    warnings.length = 0

    await model.invoke([new HumanMessage("test")])

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, "chat TruncatedMockModel")
    assert.notStrictEqual(chatSpan, undefined)
    assert.deepStrictEqual(chatSpan.attributes["gen_ai.response.finish_reasons"], ["length"])
    assert.strictEqual(chatSpan.attributes["gen_ai.response.truncated"], true)

    const truncWarn = warnings.find((w) => w.includes("truncated"))
    assert.notStrictEqual(
      truncWarn,
      undefined,
      "expected truncation warning for BaseChatModel path",
    )
  })

  it("should NOT set truncated for normal BaseChatModel responses", async () => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")

    class NormalMockModel extends BaseChatModel {
      _llmType() {
        return "mock-normal"
      }
      async _generate() {
        const msg = new AIMessage({
          content: "Complete response.",
          response_metadata: { finish_reason: "stop", id: "resp-ok-001" },
          usage_metadata: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
        })
        return { generations: [{ message: msg }] }
      }
    }

    const model = new NormalMockModel({})
    const exporter = await getSpanExporter()
    exporter.reset()
    warnings.length = 0

    await model.invoke([new HumanMessage("test")])

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, "chat NormalMockModel")
    assert.notStrictEqual(chatSpan, undefined)
    assert.deepStrictEqual(chatSpan.attributes["gen_ai.response.finish_reasons"], ["stop"])
    assert.strictEqual(chatSpan.attributes["gen_ai.response.truncated"], undefined)

    const truncWarn = warnings.find((w) => w.includes("truncated"))
    assert.strictEqual(truncWarn, undefined, "should not warn for normal responses")
  })

  // ─── gen_ai.usage.reasoning.output_tokens ──────────────────────────────

  it("should NOT set reasoning.output_tokens when not present in response", async () => {
    mock.setReasoningTokens(null)
    const exporter = await getSpanExporter()
    exporter.reset()

    await sendMsgHelper("circuit-breaker", "no reasoning")

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, /^chat /)
    assert.notStrictEqual(chatSpan, undefined)
    assert.strictEqual(chatSpan.attributes["gen_ai.usage.reasoning.output_tokens"], undefined)
  })

  // ─── gen_ai.request.stream ─────────────────────────────────────────────

  it("should NOT set gen_ai.request.stream when not streaming (default)", async () => {
    const exporter = await getSpanExporter()
    exporter.reset()

    await sendMsgHelper("circuit-breaker", "stream check")

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, /^chat /)
    assert.notStrictEqual(chatSpan, undefined)
    // Per spec: unset means non-streaming
    assert.strictEqual(chatSpan.attributes["gen_ai.request.stream"], undefined)
  })
})
