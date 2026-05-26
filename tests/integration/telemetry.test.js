const cds = require("@sap/cds")
const {
  captured,
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpanExporter,
  getSpansAfterRequest,
  findSpan,
  findSpans,
  createSendMessage,
} = require("./telemetry-utils")

// Must be called BEFORE cds.test()
setup()

const { POST, axios } = cds.test(__dirname + "/../bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/a2a - OpenTelemetry integration", () => {
  axios.defaults.validateStatus = () => true
  afterAll(teardown)
  beforeEach(resetCapture)

  // ─── E2E ────────────────────────────────────────────────────────────

  it("should complete A2A request via graph with MCP tools", async () => {
    const res = await sendMessage("graph-book", "Show me books")
    expect(res.status).toBe(200)
    expect(res.data.result).toBeDefined()
    expect(res.data.result.status.state).toBe("completed")
    expect(res.data.result.status.message.parts[0].text).toMatch(
      /Wuthering Heights|Jane Eyre|Catweazle/,
    )
  })

  // ─── Spans ──────────────────────────────────────────────────────────

  it("should create workflow span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "workflow span test"))
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).toBeDefined()
    expect(span.attributes["a2a.span.kind"]).toBe("workflow")
    expect(span.attributes["gen_ai.agent.name"]).toBe("GraphBookService")
    expect(span.attributes["a2a.task.id"]).toBeDefined()
    expect(span.attributes["a2a.context.id"]).toBeDefined()
    expect(span.attributes["a2a.outcome"]).toBe("completed")
  })

  it("should create tool span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "tool span test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool query")
    expect(span).toBeDefined()
    expect(span.attributes["a2a.span.kind"]).toBe("tool")
    expect(span.attributes["a2a.tool.name"]).toBe("query")
    expect(span.attributes["a2a.tool.outcome"]).toBe("success")
  })

  it("should create RunnableSequence spans for graph nodes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "sequence test"))
    const seqSpans = findSpans(spans, "workflow RunnableSequence")
    expect(seqSpans.length).toBeGreaterThan(0)
    const nodeNames = seqSpans.map((s) => s.name)
    expect(nodeNames.some((n) => n.includes("llm"))).toBe(true)
    expect(nodeNames.some((n) => n.includes("tools"))).toBe(true)
  })

  it("should record tool_calls requested by LLM on chat span", async () => {
    const { BaseChatModel } = require("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = require("@langchain/core/messages")

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
    const exporter = getSpanExporter()
    exporter.reset()

    // Invoke triggers the monkey-patched BaseChatModel.invoke
    await model.invoke([new HumanMessage("test")])

    const { trace } = require("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush()

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, "chat MockModelWithTools")
    expect(chatSpan).toBeDefined()
    expect(chatSpan.attributes["gen_ai.response.tool_calls"]).toBeDefined()
    const toolCalls = JSON.parse(chatSpan.attributes["gen_ai.response.tool_calls"])
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0].name).toBe("query")
    expect(toolCalls[1].name).toBe("getStock")
  })

  it("should NOT include input/output content at default log level", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "privacy test"))
    for (const span of spans) {
      expect(span.attributes["a2a.entity.input"]).toBeUndefined()
      expect(span.attributes["a2a.entity.output"]).toBeUndefined()
    }
  })

  it("should nest spans: tool is descendant of workflow", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "hierarchy test"))
    const wfSpan = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")

    expect(wfSpan).toBeDefined()
    expect(toolSpan).toBeDefined()

    expect(toolSpan.spanContext().traceId).toBe(wfSpan.spanContext().traceId)
    const toolParent = spans.find((s) => s.spanContext().spanId === toolSpan.parentSpanId)
    const isDirectChild = toolSpan.parentSpanId === wfSpan.spanContext().spanId
    const isGrandchild = toolParent?.parentSpanId === wfSpan.spanContext().spanId
    expect(isDirectChild || isGrandchild).toBe(true)
  })

  // ─── Monkey-patching ────────────────────────────────────────────────

  it("should have LangChain patches applied (feature flag default on)", () => {
    expect(cds.env.a2a.trace_langchain).not.toBe(false)
    const { BaseChatModel } = require("@langchain/core/language_models/chat_models")
    const PATCHED = Symbol.for("@cap-js/a2a:patched")
    expect(BaseChatModel.prototype[PATCHED]).toBe(true)
  })

  it("should patch StructuredTool.invoke", () => {
    const { StructuredTool } = require("@langchain/core/tools")
    const PATCHED = Symbol.for("@cap-js/a2a:patched")
    expect(StructuredTool.prototype[PATCHED]).toBe(true)
  })

  it("should patch RunnableLambda.invoke", () => {
    const { RunnableLambda } = require("@langchain/core/runnables")
    const PATCHED = Symbol.for("@cap-js/a2a:patched")
    expect(RunnableLambda.prototype[PATCHED]).toBe(true)
  })

  // ─── Metrics ────────────────────────────────────────────────────────

  it("should record golden signal metrics", async () => {
    await sendMessage("graph-book", "Metrics test")
    const output = await flushMetrics()
    expect(output).toMatch(/a2a\.requests\.total/)
    expect(output).toMatch(/a2a\.request\.duration/)
    expect(output).toMatch(/a2a\.workflows\.completed/)
    expect(output).toMatch(/agent_actions/)
    expect(output).toMatch(/a2a\.tool\.invocations/)
    expect(output).toMatch(/sap\.tenantId/)
  })

  it("should record LLM metrics (tokens, invocations)", async () => {
    await sendMessage("graph-book", "LLM test")
    const output = await flushMetrics()
    expect(output).toMatch(/a2a\.llm\.input_tokens/)
    expect(output).toMatch(/a2a\.llm\.output_tokens/)
    expect(output).toMatch(/a2a\.llm\.invocations/)
    expect(output).toMatch(/mock-model-for-testing/)
  })

  // ─── Correlation ────────────────────────────────────────────────────

  it("should register cls_custom_fields for A2A correlation", () => {
    const cls_fields = cds.env.log.cls_custom_fields
    expect(cls_fields).toBeDefined()
    expect(cls_fields).toContain("a2a.task.id")
    expect(cls_fields).toContain("a2a.context.id")
  })

  it("should set A2A correlation IDs on responses", async () => {
    const res = await sendMessage("graph-book", "Correlation test")
    expect(res.status).toBe(200)
    expect(res.data.result.id).toBeDefined()
    expect(res.data.result.id.length).toBeGreaterThan(0)
    expect(res.data.result.contextId).toBeDefined()
  })
})
