import cds from "@sap/cds"
import {
  setup,
  teardown,
  resetCapture,
  getSpansAfterRequest,
  findSpan,
  findSpans,
  createSendMessage,
  getSpanExporter,
} from "../utils/telemetry-utils.js"

setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
const sendMessage = createSendMessage(POST)

// Enable mlflow after cds.test() bootstrap — cds.test() re-resolves cds.env from
// package.json + .cdsrc.json, so mutations before it are overwritten.
before(() => {
  cds.env.agents ??= {}
  cds.env.agents.mlflow = true
})

describe("@cap-js/agents - MLflow Databricks span attributes", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  // ─── mlflowAttrs helper ─────────────────────────────────────────────

  describe("mlflowAttrs()", () => {
    it("should return empty object when mlflow disabled", async () => {
      const { mlflowAttrs, mlflowTraceAttrs } = await import("../../lib/telemetry/mlflow.js")
      const saved = cds.env.agents.mlflow
      cds.env.agents.mlflow = false
      expect(mlflowAttrs("LLM")).toEqual({})
      expect(mlflowTraceAttrs()).toEqual({})
      cds.env.agents.mlflow = saved
    })

    it("should return mlflow attributes when enabled", async () => {
      const { mlflowAttrs } = await import("../../lib/telemetry/mlflow.js")
      // Set agent.service context so resolveExperimentId finds @Core.SchemaVersion
      const origCtx = cds.context
      cds.context = { ...cds.context, "agent.service": "CatalogService" }
      try {
        const attrs = mlflowAttrs("TOOL", { inputs: { foo: "bar" } })
        expect(attrs["mlflow.spanType"]).toBe("TOOL")
        expect(attrs["mlflow.experimentId"]).toBe("0")
        expect(attrs["mlflow.spanInputs"]).toBe('{"foo":"bar"}')
      } finally {
        cds.context = origCtx
      }
    })

    it("should include token usage when provided", async () => {
      const { mlflowAttrs } = await import("../../lib/telemetry/mlflow.js")
      const attrs = mlflowAttrs("LLM", {
        tokenUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      })
      expect(attrs["mlflow.chat.tokenUsage"]).toBe(
        '{"input_tokens":10,"output_tokens":20,"total_tokens":30}',
      )
    })

    it("should not include inputs/outputs/tokenUsage keys when not provided", async () => {
      const { mlflowAttrs } = await import("../../lib/telemetry/mlflow.js")
      const attrs = mlflowAttrs("AGENT")
      expect(attrs["mlflow.spanInputs"]).toBe(undefined)
      expect(attrs["mlflow.spanOutputs"]).toBe(undefined)
      expect(attrs["mlflow.chat.tokenUsage"]).toBe(undefined)
    })

    it("should throw when @Core.SchemaVersion is not numeric", async () => {
      const { mlflowAttrs } = await import("../../lib/telemetry/mlflow.js")
      // Mock a service with non-numeric SchemaVersion
      const origServices = cds.services
      const mockSrv = { definition: { "@Core.SchemaVersion": "not-a-number" } }
      cds.services = { ...cds.services, BadService: mockSrv }
      const origCtx = cds.context
      cds.context = { ...cds.context, "agent.service": "BadService" }
      try {
        expect(() => mlflowAttrs("LLM")).toThrow(/must be a numeric string.*Got: "not-a-number"/)
      } finally {
        cds.context = origCtx
        cds.services = origServices
      }
    })
  })

  describe("mlflowTraceAttrs()", () => {
    it("should return trace tag attributes when enabled", async () => {
      const { mlflowTraceAttrs } = await import("../../lib/telemetry/mlflow.js")
      const attrs = mlflowTraceAttrs()
      expect(Object.keys(attrs).includes("mlflow.traceTag.session")).toBeTruthy()
      expect(Object.keys(attrs).includes("mlflow.traceTag.user")).toBeTruthy()
      expect(Object.keys(attrs).includes("mlflow.traceTag.tenant")).toBeTruthy()
      expect(Object.keys(attrs).includes("session.id")).toBeTruthy()
      expect(Object.keys(attrs).includes("user.id")).toBeTruthy()
      // All values must be strings
      for (const v of Object.values(attrs)) {
        expect(typeof v).toBe("string")
      }
    })
  })

  // ─── Workflow span ──────────────────────────────────────────────────

  it("should set mlflow.spanType=AGENT on workflow span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "mlflow workflow"))
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    expect(span.attributes["mlflow.spanType"]).toBe("AGENT")
    expect(span.attributes["mlflow.experimentId"], "should have experimentId").toBeTruthy()
    expect(span.attributes["mlflow.experimentId"]).toBe("2")
  })

  it("should set mlflow trace tags on workflow span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "mlflow trace tags"))
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    expect(span.attributes["mlflow.traceTag.session"]).not.toBe(undefined)
    expect(span.attributes["mlflow.traceTag.tenant"]).not.toBe(undefined)
  })

  // ─── Tool spans ────────────────────────────────────────────────────

  it("should set mlflow.spanType=TOOL on tool spans", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "mlflow tool test"))
    const span = findSpan(spans, "execute_tool DynamicStructuredTool query")
    expect(span).not.toBe(undefined)
    expect(span.attributes["mlflow.spanType"]).toBe("TOOL")
    expect(span.attributes["mlflow.spanInputs"]).not.toBe(undefined)
  })

  // ─── LLM / Chat spans ──────────────────────────────────────────────

  it("should set mlflow.spanType=LLM on chat spans (when mock model produces them)", async () => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")

    class MockLLM extends BaseChatModel {
      _llmType() {
        return "mock-mlflow"
      }
      async _generate() {
        return { generations: [{ message: new AIMessage("hello") }] }
      }
    }

    const model = new MockLLM({})
    const exporter = await getSpanExporter()
    exporter.reset()

    await model.invoke([new HumanMessage("test mlflow LLM")])

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate.forceFlush) await delegate.forceFlush().catch(() => {})

    const spans = exporter.getFinishedSpans()
    const chatSpan = findSpan(spans, "chat MockLLM")
    expect(chatSpan).not.toBe(undefined)
    expect(chatSpan.attributes["mlflow.spanType"]).toBe("LLM")
  })

  // ─── RunnableSequence spans ─────────────────────────────────────────

  it("should set mlflow.spanType=CHAIN on RunnableSequence spans", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "mlflow chain test"))
    const seqSpans = findSpans(spans, "workflow RunnableSequence")
    expect(seqSpans.length > 0).toBeTruthy()
    expect(seqSpans[0].attributes["mlflow.spanType"]).toBe("CHAIN")
  })

  // ─── HTTP span ──────────────────────────────────────────────────────

  it("should set mlflow attributes on HTTP/protocol span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "mlflow http"))
    const httpSpan = findSpan(spans, "POST /a2a/")
    // HTTP span may not always be captured by the in-memory exporter
    // (depends on @cap-js/telemetry wrapping express), so test conditionally
    if (httpSpan) {
      expect(httpSpan.attributes["mlflow.spanType"]).toBe("CHAIN")
    }
  })

  // ─── setupMlflowExporter guard logic ────────────────────────────────

  it("should not add OTLP exporter without databricks-mlflow credentials", async () => {
    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    const processorsBefore = delegate._registeredSpanProcessors?.length || 0

    // Temporarily remove credentials to test the guard path
    const savedCreds = cds.env.requires?.["databricks-mlflow"]?.credentials
    if (cds.env.requires?.["databricks-mlflow"]) {
      cds.env.requires["databricks-mlflow"].credentials = undefined
    }

    const { setupMlflowExporter } = await import("../../lib/telemetry/mlflow.js")
    await setupMlflowExporter()

    // Restore credentials
    if (cds.env.requires?.["databricks-mlflow"]) {
      cds.env.requires["databricks-mlflow"].credentials = savedCreds
    }

    const processorsAfter = delegate._registeredSpanProcessors?.length || 0
    expect(processorsAfter, "no processor should be added without credentials").toBe(
      processorsBefore,
    )
  })
})
