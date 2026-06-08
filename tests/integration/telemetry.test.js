import assert from "node:assert/strict"
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
  getSpanExporter,
} from "../utils/telemetry-utils.js"

// Disable cds.test() console silencing so we can capture telemetry output
process.env.CDS_TEST_SILENT = "false"

// Must be called BEFORE cds.test()
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../bookshop")
const sendMessage = createSendMessage(POST)

// Span/metrics tests require [test] profile telemetry config (ConsoleSpanExporter).
// In hybrid mode, telemetry uses different exporters that our in-memory capture can't intercept.
const isHybrid = cds.env.profiles?.includes("hybrid")

describe("@cap-js/a2a - OpenTelemetry integration", { skip: isHybrid }, () => {
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
    assert.strictEqual(span.attributes["a2a.span.kind"], "workflow")
    assert.strictEqual(span.attributes["gen_ai.agent.name"], "GraphBookService")
    assert.notStrictEqual(span.attributes["a2a.task.id"], undefined)
    assert.notStrictEqual(span.attributes["a2a.context.id"], undefined)
    assert.strictEqual(span.attributes["a2a.outcome"], "completed")
  })

  it("should create tool span with correct name and attributes", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "tool span test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool query")
    assert.notStrictEqual(span, undefined)
    assert.strictEqual(span.attributes["a2a.span.kind"], "tool")
    assert.strictEqual(span.attributes["a2a.tool.name"], "query")
    assert.strictEqual(span.attributes["a2a.tool.outcome"], "success")
  })

  it("should create tool span for custom (non-CDS) tools via prototype patch", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "custom tool test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool getBookCount")
    assert.notStrictEqual(span, undefined)
    assert.strictEqual(span.attributes["a2a.span.kind"], "tool")
    assert.strictEqual(span.attributes["a2a.tool.name"], "getBookCount")
    assert.strictEqual(span.attributes["a2a.tool.outcome"], "success")
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
      assert.strictEqual(span.attributes["a2a.entity.input"], undefined)
      assert.strictEqual(span.attributes["a2a.entity.output"], undefined)
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
    assert.notStrictEqual(cds.env.a2a.trace_langchain, false)
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const PATCHED = Symbol.for("@cap-js/a2a:patched")
    assert.strictEqual(BaseChatModel.prototype[PATCHED], true)
  })

  it("should patch StructuredTool.invoke", async () => {
    const { StructuredTool } = await import("@langchain/core/tools")
    const PATCHED = Symbol.for("@cap-js/a2a:patched")
    assert.strictEqual(StructuredTool.prototype[PATCHED], true)
  })

  it("should patch RunnableLambda.invoke", async () => {
    const { RunnableLambda } = await import("@langchain/core/runnables")
    const PATCHED = Symbol.for("@cap-js/a2a:patched")
    assert.strictEqual(RunnableLambda.prototype[PATCHED], true)
  })

  // ─── Metrics ────────────────────────────────────────────────────────

  it("should record golden signal metrics", async () => {
    await sendMessage("graph-book", "Metrics test")
    const output = await flushMetrics()
    assert.match(output, /a2a\.requests\.total/)
    assert.match(output, /a2a\.request\.duration/)
    assert.match(output, /a2a\.workflows\.completed/)
    assert.match(output, /agent_actions/)
    assert.match(output, /a2a\.tool\.invocations/)
    assert.match(output, /sap\.tenantId/)
  })

  it("should record LLM metrics (tokens, invocations)", async () => {
    await sendMessage("graph-book", "LLM test")
    const output = await flushMetrics()
    assert.match(output, /a2a\.llm\.input_tokens/)
    assert.match(output, /a2a\.llm\.output_tokens/)
    assert.match(output, /a2a\.llm\.invocations/)
    assert.match(output, /mock-model-for-testing/)
  })

  // ─── Correlation ────────────────────────────────────────────────────

  it("should register cls_custom_fields for A2A correlation", () => {
    const cls_fields = cds.env.log.cls_custom_fields
    assert.notStrictEqual(cls_fields, undefined)
    assert.ok(cls_fields.includes("a2a.task.id"))
    assert.ok(cls_fields.includes("a2a.context.id"))
  })

  it("should set A2A correlation IDs on responses", async () => {
    const res = await sendMessage("graph-book", "Correlation test")
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.result.id, undefined)
    assert.ok(res.data.result.id.length > 0, `expected ${res.data.result.id.length} > 0`)
    assert.notStrictEqual(res.data.result.contextId, undefined)
  })
})
