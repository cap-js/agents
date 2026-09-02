/**
 * Tests @cap-js/agents telemetry with @cap-js/telemetry v1 (OTEL SDK v1)
 * to guarantee backward compatibility.
 *
 * Main test suites (telemetry.test.js, telemetry-mlflow.test.js,
 * telemetry-debug.test.js) run against v2. This file is the v1 counterpart —
 * narrow, focused only on code paths that could differ between SDK versions.
 *
 * v1-specific characteristics verified:
 * - BasicTracerProvider.addSpanProcessor() exists (v1-only API)
 * - ReadableSpan.parentSpanId is set (v1 shape; v2 moved it to parentSpanContext)
 * - Spans, metrics, mlflow processor registration all work through the v1 path
 */
import cds from "@sap/cds"
import {
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpansAfterRequest,
  findSpan,
  createSendMessage,
  getSpanExporter,
} from "../utils/telemetry-utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/telemetry-v1")
const sendMessage = createSendMessage(POST)

describe("@cap-js/agents - OTEL v1 backward compatibility (@cap-js/telemetry ^1)", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  // ─── Confirm we're actually running against OTEL SDK v1 ────────────────
  // Guards against silent version mixups.

  it("should be running against OTEL SDK v1 (addSpanProcessor exists on provider)", async () => {
    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    expect(
      typeof delegate.addSpanProcessor,
      "if this is not a function, sample is on OTEL v2 — v1 test is not covering v1",
    ).toBe("function")
  })

  // ─── Spans carry attributes set via span.setAttribute() ────────────────

  it("should set gen_ai.* attributes on workflow span (v1 setAttribute)", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("otel-v1", "attr test"))
    const wf = findSpan(spans, "workflow CompiledStateGraph OtelV1Service")
    expect(wf).not.toBe(undefined)
    expect(wf.attributes["gen_ai.operation.name"]).toBe("invoke_agent")
    expect(wf.attributes["gen_ai.agent.name"]).toBe("OtelV1Service")
    expect(wf.attributes["agent.outcome"]).toBe("completed")
  })

  // ─── Context propagation via parentSpanId (v1 ReadableSpan shape) ──────

  it("should propagate span context: tool is descendant of workflow (v1 parentSpanId)", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("otel-v1", "hierarchy test"))
    const wf = findSpan(spans, "workflow CompiledStateGraph OtelV1Service")
    const tool = findSpan(spans, "execute_tool DynamicStructuredTool query")
    expect(wf).not.toBe(undefined)
    expect(tool).not.toBe(undefined)
    expect(tool.spanContext().traceId).toBe(wf.spanContext().traceId)

    // v1 shape: parentSpanId is a string on the ReadableSpan
    expect(typeof tool.parentSpanId).toBe("string")

    const wfId = wf.spanContext().spanId
    let cur = tool
    let descendant = false
    for (let depth = 0; depth < 10; depth++) {
      const pid = cur?.parentSpanId
      if (pid === wfId) {
        descendant = true
        break
      }
      // Empty string = root span in v1; stop the walk explicitly.
      if (pid == null || pid === "") break
      cur = spans.find((s) => s.spanContext().spanId === pid)
      if (!cur) break
    }
    expect(descendant).toBe(true)
  })

  // ─── Error path: setStatus + tool.call.outcome=error ────────────────────

  it("should record error status on tool span when tool throws (v1)", async () => {
    const { DynamicStructuredTool } = await import("@langchain/core/tools")
    const { z } = await import("zod")

    const failingTool = new DynamicStructuredTool({
      name: "failingTool",
      description: "always throws",
      schema: z.object({}),
      func: async () => {
        throw new Error("intentional failure for v1 error path test")
      },
    })

    const exporter = await getSpanExporter()
    exporter.reset()

    await expect(failingTool.invoke({})).rejects.toThrow(/intentional failure/)

    const { trace } = await import("@opentelemetry/api")
    const delegate = trace.getTracerProvider().getDelegate?.() || trace.getTracerProvider()
    if (delegate.forceFlush) await delegate.forceFlush().catch(() => {})

    const spans = exporter.getFinishedSpans()
    const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool failingTool")
    expect(toolSpan).not.toBe(undefined)
    expect(toolSpan.attributes["gen_ai.tool.call.outcome"]).toBe("error")
    // OTEL status code 2 = ERROR (same enum v1 + v2)
    expect(toolSpan.status.code).toBe(2)
  })

  // ─── Metrics with attributes ────────────────────────────────────────────

  it("should emit metrics with sap.tenantId + agent.service attributes (v1)", async () => {
    await sendMessage("otel-v1", "metrics attr test")
    const output = await flushMetrics()
    expect(output).toMatch(/agent\.requests\.total/)
    expect(output).toMatch(/agent\.tool\.invocations/)
    expect(output).toMatch(/sap\.tenantId/)
    expect(output).toMatch(/agent\.service/)
    expect(output).toMatch(/tool: /)
    expect(output).toMatch(/outcome: /)
  })

  // ─── mlflow folder v1 path: setupMlflowExporter calls addSpanProcessor ──────
  // Complements the v2 test in telemetry-mlflow.test.js.

  it("should register mlflow span processor via v1 addSpanProcessor path", async () => {
    const { trace } = await import("@opentelemetry/api")
    const delegate = trace.getTracerProvider().getDelegate?.() || trace.getTracerProvider()

    // Precondition: v1 API surface present
    expect(typeof delegate.addSpanProcessor).toBe("function")

    // Spy on addSpanProcessor to prove the v1 branch runs
    const original = delegate.addSpanProcessor.bind(delegate)
    let called = 0
    delegate.addSpanProcessor = function (...args) {
      called++
      return original(...args)
    }

    const savedMlflow = cds.env.agents?.mlflow
    const savedMlflowReq = cds.env.requires?.mlflow
    cds.env.agents ??= {}
    cds.env.agents.mlflow = true
    cds.env.requires ??= {}
    cds.env.requires.mlflow = {
      credentials: {
        MLFLOW_OTLP_ENDPOINT: "http://localhost:65535/api/2.0/otlp/v1/traces",
        MLFLOW_TOKEN: "test-token",
      },
    }

    try {
      const { setupMlflowExporter } = await import("../../lib/telemetry/mlflow/index.js")
      await setupMlflowExporter()
      expect(called, "v1 addSpanProcessor path must run").toBe(1)
    } finally {
      delegate.addSpanProcessor = original
      cds.env.agents.mlflow = savedMlflow
      if (savedMlflowReq === undefined) delete cds.env.requires.mlflow
      else cds.env.requires.mlflow = savedMlflowReq
    }
  })

  // ─── E2E sanity ─────────────────────────────────────────────────────────

  it("should complete A2A request end-to-end on OTEL v1", async () => {
    const res = await sendMessage("otel-v1", "Show me books")
    expect(res.status).toBe(200)
    expect(res.data.result.status.state).toBe("completed")
    expect(res.data.result.status.message.parts[0].text).toMatch(
      /Wuthering Heights|Jane Eyre|Catweazle/,
    )
  })
})
