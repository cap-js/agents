import cds from "@sap/cds"
import {
  setup,
  teardown,
  resetCapture,
  captured,
  getSpansAfterRequest,
  findSpan,
  findSpans,
  createSendMessage,
  createSendMessageWithParts,
  getSpanExporter,
} from "../utils/telemetry-utils.js"

setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
const sendMessage = createSendMessage(POST)
const sendMessageWithParts = createSendMessageWithParts(POST)

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

  // ─── message part handling in traces ───────────────────────────────

  it("data part — mlflow.spanInputs contains JSON-stringified data content", async () => {
    const spans = await getSpansAfterRequest(() =>
      sendMessageWithParts("graph-book", [{ kind: "data", data: { query: "books", limit: 3 } }]),
    )
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    const inputs = JSON.parse(span.attributes["mlflow.spanInputs"])
    expect(inputs.messages).toHaveLength(1)
    expect(inputs.messages[0].role).toBe("user")
    // data part → pretty-printed JSON as text content
    expect(inputs.messages[0].content).toContain('"query"')
    expect(inputs.messages[0].content).toContain('"books"')
  })

  it("mixed text + data parts — mlflow.spanInputs joins both in content", async () => {
    const spans = await getSpansAfterRequest(() =>
      sendMessageWithParts("graph-book", [
        { kind: "text", text: "Filter by:" },
        { kind: "data", data: { genre: "fiction" } },
      ]),
    )
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    const inputs = JSON.parse(span.attributes["mlflow.spanInputs"])
    expect(inputs.messages[0].role).toBe("user")
    // two parts → content array
    const content = inputs.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content.find((b) => b.type === "text" && b.text === "Filter by:")).toBeTruthy()
    expect(content.find((b) => b.type === "text" && b.text.includes('"fiction"'))).toBeTruthy()
  })

  it("file part (image) — mlflow.spanInputs contains image_url content block", async () => {
    const spans = await getSpansAfterRequest(() =>
      sendMessageWithParts("graph-book", [
        { kind: "file", file: { bytes: "aGVsbG8=", mimeType: "image/png", name: "img.png" } },
      ]),
    )
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    const inputs = JSON.parse(span.attributes["mlflow.spanInputs"])
    const content = inputs.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    const imgBlock = content.find((b) => b.type === "image_url")
    expect(imgBlock).toBeTruthy()
    expect(imgBlock.image_url.url).toMatch(/^data:image\/png;base64,/)
  })

  it("file part (non-image) — mlflow.spanInputs contains text label, not image_url", async () => {
    const spans = await getSpansAfterRequest(() =>
      sendMessageWithParts("graph-book", [
        { kind: "file", file: { bytes: "aGVsbG8=", mimeType: "application/pdf", name: "doc.pdf" } },
      ]),
    )
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    const inputs = JSON.parse(span.attributes["mlflow.spanInputs"])
    const content = inputs.messages[0].content
    // single non-image file → plain string label
    expect(typeof content === "string" || Array.isArray(content)).toBe(true)
    const label = Array.isArray(content) ? content[0].text : content
    expect(label).toContain("doc.pdf")
    expect(label).toContain("application/pdf")
  })

  it("mlflow.message.format=langchain-js set on workflow span", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("graph-book", "message format test"))
    const span = findSpan(spans, "workflow CompiledStateGraph GraphBookService")
    expect(span).not.toBe(undefined)
    expect(span.attributes["mlflow.message.format"]).toBe("langchain-js")
  })

  // ─── Unity Catalog header ───────────────────────────────────────────

  it("UC table name header composed from UC_CATALOG + UC_SCHEMA + UC_TABLE_PREFIX", async () => {
    const { RoutingSpanProcessor } = await import("../../lib/telemetry/mlflow.js")

    const exporterHeaders = []
    class CapturingExporter {
      constructor({ headers }) {
        exporterHeaders.push(headers)
      }
    }
    class FakeBatchProcessor {
      constructor() {}
      onEnd() {}
    }

    const proc = new RoutingSpanProcessor({
      url: "https://example.com/v1/traces",
      token: "tok",
      ucTableName: "main.mlflow_traces.myapp_otel_spans",
      BatchSpanProcessor: FakeBatchProcessor,
      OTLPTraceExporter: CapturingExporter,
    })
    proc.onEnd({ attributes: { "mlflow.experimentId": "42" } })

    expect(exporterHeaders).toHaveLength(1)
    expect(exporterHeaders[0]["X-Databricks-UC-Table-Name"]).toBe(
      "main.mlflow_traces.myapp_otel_spans",
    )
    expect(exporterHeaders[0]["x-mlflow-experiment-id"]).toBe("42")
  })

  it("UC table name omitted from header when ucTableName not set", async () => {
    const { RoutingSpanProcessor } = await import("../../lib/telemetry/mlflow.js")

    const exporterHeaders = []
    class CapturingExporter {
      constructor({ headers }) {
        exporterHeaders.push(headers)
      }
    }
    class FakeBatchProcessor {
      constructor() {}
      onEnd() {}
    }

    const proc = new RoutingSpanProcessor({
      url: "https://example.com/v1/traces",
      token: "tok",
      ucTableName: undefined,
      BatchSpanProcessor: FakeBatchProcessor,
      OTLPTraceExporter: CapturingExporter,
    })
    proc.onEnd({ attributes: { "mlflow.experimentId": "99" } })

    expect(exporterHeaders).toHaveLength(1)
    expect(exporterHeaders[0]["X-Databricks-UC-Table-Name"]).toBeUndefined()
  })

  it("ucTableName composed correctly from UC_CATALOG + UC_SCHEMA + UC_TABLE_PREFIX credentials", async () => {
    const savedCreds = cds.env.requires?.["databricks-mlflow"]?.credentials
    cds.env.requires ??= {}
    cds.env.requires["databricks-mlflow"] ??= {}
    cds.env.requires["databricks-mlflow"].credentials = {
      DATABRICKS_HOST: "https://adb-123.azuredatabricks.net",
      DATABRICKS_TOKEN: "dapi-test",
      UC_CATALOG: "main",
      UC_SCHEMA: "traces",
      UC_TABLE_PREFIX: "myapp",
    }

    const { setupMlflowExporter } = await import("../../lib/telemetry/mlflow.js")
    await setupMlflowExporter()

    cds.env.requires["databricks-mlflow"].credentials = savedCreds

    // setupMlflowExporter logs the ucTableName — verify it was composed correctly
    const logLine = captured.find((l) => l.includes("ucTableName"))
    expect(logLine).toBeTruthy()
    expect(logLine).toContain("main.traces.myapp_otel_spans")
  })

  it("should not add OTLP exporter without databricks-mlflow credentials", async () => {
    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    // v1: _registeredSpanProcessors, v2: _activeSpanProcessor._spanProcessors
    const getCount = () =>
      delegate._registeredSpanProcessors?.length ??
      delegate._activeSpanProcessor?._spanProcessors?.length ??
      0
    const processorsBefore = getCount()

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

    const processorsAfter = getCount()
    expect(processorsAfter, "no processor should be added without credentials").toBe(
      processorsBefore,
    )
  })
})
