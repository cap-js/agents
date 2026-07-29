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

describe.skipIf(isHybrid)("@cap-js/agents - OpenTelemetry integration", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  // ─── E2E ────────────────────────────────────────────────────────────

  it("should complete A2A request via graph with MCP tools", async () => {
    const res = await sendMessage("graph-book", "Show me books")
    expect(res.status).toBe(200)
    expect(res.data.result).not.toBe(undefined)
    expect(res.data.result.status.state).toBe("completed")
    expect(res.data.result.status.message.parts[0].text).toMatch(
      /Wuthering Heights|Jane Eyre|Catweazle/,
    )
  })

  // ─── Spans ──────────────────────────────────────────────────────────

  it("should create workflow span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "workflow span test"))
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    expect(span.attributes["gen_ai.operation.name"]).toBe("invoke_agent")
    expect(span.attributes["gen_ai.agent.name"]).toBe("GraphBookService")
    expect(span.attributes["agent.task.id"]).not.toBe(undefined)
    expect(span.attributes["agent.context.id"]).not.toBe(undefined)
    expect(span.attributes["agent.outcome"]).toBe("completed")
  })

  it("should create tool span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "tool span test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool query")
    expect(span).not.toBe(undefined)
    expect(span.attributes["gen_ai.operation.name"]).toBe("execute_tool")
    expect(span.attributes["gen_ai.tool.call.id"]).toBe("query")
    expect(span.attributes["gen_ai.tool.call.outcome"]).toBe("success")
  })

  it("should create tool span for custom (non-CDS) tools via prototype patch", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "custom tool test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool getBookCount")
    expect(span).not.toBe(undefined)
    expect(span.attributes["gen_ai.operation.name"]).toBe("execute_tool")
    expect(span.attributes["gen_ai.tool.call.id"]).toBe("getBookCount")
    expect(span.attributes["gen_ai.tool.call.outcome"]).toBe("success")
  })

  it("should create RunnableSequence spans for graph nodes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "sequence test"))
    const seqSpans = findSpans(spans, "workflow RunnableSequence")
    expect(seqSpans.length > 0, `expected ${seqSpans.length} > 0`).toBeTruthy()
    const nodeNames = seqSpans.map((s) => s.name)
    expect(nodeNames.some((n) => n.includes("llm"))).toBe(true)
    expect(nodeNames.some((n) => n.includes("tools"))).toBe(true)
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.tool_calls"]).not.toBe(undefined)
    const toolCalls = JSON.parse(chatSpan.attributes["gen_ai.response.tool_calls"])
    expect(toolCalls.length).toBe(2)
    expect(toolCalls[0].name).toBe("query")
    expect(toolCalls[1].name).toBe("getStock")
  })

  it("should NOT include input/output content at default log level", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "privacy test"))
    for (const span of spans) {
      expect(span.attributes["gen_ai.input.messages"]).toBe(undefined)
      expect(span.attributes["gen_ai.output.messages"]).toBe(undefined)
    }
  })

  it("should nest spans: tool is descendant of workflow", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "hierarchy test"))
    const wfSpan = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")

    expect(wfSpan).not.toBe(undefined)
    expect(toolSpan).not.toBe(undefined)

    expect(toolSpan.spanContext().traceId).toBe(wfSpan.spanContext().traceId)
    // OTEL v1 uses parentSpanId, v2 uses parentSpanContext.spanId

    const getParentId = (span) => {
      if (span == null) return null
      if (span.parentSpanContext?.spanId != null) return span.parentSpanContext.spanId
      if (span.parentSpanId != null) return span.parentSpanId
      return null
    }
    const toolParent = spans.find((s) => s.spanContext().spanId === getParentId(toolSpan))
    const isDirectChild = getParentId(toolSpan) === wfSpan.spanContext().spanId
    const isGrandchild = getParentId(toolParent) === wfSpan.spanContext().spanId
    expect(isDirectChild || isGrandchild).toBe(true)
  })

  // ─── Monkey-patching ────────────────────────────────────────────────

  it("should have LangChain patches applied (feature flag default on)", async () => {
    expect(cds.env.agents.trace_langchain).not.toBe(false)
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    expect(BaseChatModel.prototype[PATCHED]).toBe(true)
  })

  it("should patch StructuredTool.invoke", async () => {
    const { StructuredTool } = await import("@langchain/core/tools")
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    expect(StructuredTool.prototype[PATCHED]).toBe(true)
  })

  it("should patch RunnableLambda.invoke", async () => {
    const { RunnableLambda } = await import("@langchain/core/runnables")
    const PATCHED = Symbol.for("@cap-js/agents:patched")
    expect(RunnableLambda.prototype[PATCHED]).toBe(true)
  })

  // ─── Metrics ────────────────────────────────────────────────────────

  it("should record golden signal metrics", async () => {
    await sendMessage("graph-book", "Metrics test")
    const output = await flushMetrics()
    expect(output).toMatch(/agent\.requests\.total/)
    expect(output).toMatch(/agent\.request\.duration/)
    expect(output).toMatch(/agent\.workflows\.completed/)
    expect(output).toMatch(/agent_actions/)
    expect(output).toMatch(/agent\.tool\.invocations/)
    expect(output).toMatch(/sap\.tenantId/)
  })

  it("should record LLM metrics (tokens, invocations)", async () => {
    await sendMessage("graph-book", "LLM test")
    const output = await flushMetrics()
    expect(output).toMatch(/agent\.llm\.input_tokens/)
    expect(output).toMatch(/agent\.llm\.output_tokens/)
    expect(output).toMatch(/agent\.llm\.invocations/)
    expect(output).toMatch(/mock-model-for-testing/)
  })

  // ─── Correlation ────────────────────────────────────────────────────

  it("should register cls_custom_fields for A2A correlation", () => {
    const cls_fields = cds.env.log.cls_custom_fields
    expect(cls_fields).not.toBe(undefined)
    expect(cls_fields.includes("agent.task.id")).toBeTruthy()
    expect(cls_fields.includes("agent.context.id")).toBeTruthy()
  })

  it("should set A2A correlation IDs on responses", async () => {
    const res = await sendMessage("graph-book", "Correlation test")
    expect(res.status).toBe(200)
    expect(res.data.result.id).not.toBe(undefined)
    expect(res.data.result.id.length > 0, `expected ${res.data.result.id.length} > 0`).toBeTruthy()
    expect(res.data.result.contextId).not.toBe(undefined)
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenAI Semantic Convention compliance tests (uses mock AI Core)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(isHybrid)("@cap-js/agents - GenAI Semantic Conventions", () => {
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
    expect(chatSpan, "expected chat span").not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.model"]).toBe("gpt-4-turbo-2024-04-09")
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.model"]).toBe("claude-4-sonnet-20250514")
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"])
    expect(chatSpan.attributes["gen_ai.response.truncated"]).toBe(undefined)
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.finish_reasons"]).toEqual(["length"])
    expect(chatSpan.attributes["gen_ai.response.truncated"]).toBe(true)

    const truncWarn = warnings.find((w) => w.includes("truncated"))
    expect(truncWarn, "expected truncation warning").not.toBe(undefined)
    expect(truncWarn).toMatch(/max_tokens/)
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.finish_reasons"]).toEqual(["max_tokens"])
    expect(chatSpan.attributes["gen_ai.response.truncated"]).toBe(true)
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.finish_reasons"]).toEqual(["length"])
    expect(chatSpan.attributes["gen_ai.response.truncated"]).toBe(true)

    const truncWarn = warnings.find((w) => w.includes("truncated"))
    expect(truncWarn, "expected truncation warning for BaseChatModel path").not.toBe(undefined)
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"])
    expect(chatSpan.attributes["gen_ai.response.truncated"]).toBe(undefined)

    const truncWarn = warnings.find((w) => w.includes("truncated"))
    expect(truncWarn, "should not warn for normal responses").toBe(undefined)
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
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.usage.reasoning.output_tokens"]).toBe(undefined)
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
    expect(chatSpan).not.toBe(undefined)
    // Per spec: unset means non-streaming
    expect(chatSpan.attributes["gen_ai.request.stream"]).toBe(undefined)
  })
})
