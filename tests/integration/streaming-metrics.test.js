import cds from "@sap/cds"
import { createMockAICore } from "../utils/mock-ai-core.js"
import {
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpansAfterRequest,
  findSpan,
} from "../utils/telemetry-utils.js"
import createHelpers from "../utils/helpers.js"

// Start mock AI Core BEFORE cds.test() boots
const mock = createMockAICore()
const mockPort = await mock.start()
process.env.MOCK_AICORE_PORT = String(mockPort)

// Disable cds.test() console silencing so we can capture telemetry output
process.env.CDS_TEST_SILENT = "false"

setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const { sendMessage } = createHelpers({ POST, axios })

const isHybrid = cds.env.profiles?.includes("hybrid")
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms))

/** Filter audit logs by original event name (stored in data.data.event) */
const byEvent = (name) => (l) => l.event === "SecurityEvent" && l.data?.data?.event === name

describe.skipIf(isHybrid)("@cap-js/agents - Streaming path metrics + audit", () => {
  axios.defaults.validateStatus = () => true

  let _auditLogs
  let originalQuota

  before(async () => {
    originalQuota = cds.env.agents.pool.maxTasksPerHourPerUser
    cds.env.agents.pool.maxTasksPerHourPerUser = 200

    // Wire audit capture
    if (!cds.env.requires?.["audit-log"]?.kind)
      cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }
    const audit = await cds.connect.to("audit-log")
    _auditLogs = []
    audit.after("*", (_, req) => {
      _auditLogs.push({ event: req.event, data: JSON.parse(JSON.stringify(req.data)) })
    })
  })

  after(() => {
    cds.env.agents.pool.maxTasksPerHourPerUser = originalQuota
    teardown()
    mock.stop()
  })

  beforeEach(() => {
    _auditLogs.length = 0
    mock.resetCallCount()
    mock.setStatus(200)
    mock.setFinishReason("stop")
    resetCapture()
  })

  // ─── Basic completion ───────────────────────────────────────────────

  it("should complete task via streaming path", async () => {
    const res = await sendMessage("streaming-metrics", "hello streaming")
    expect(res.data.result?.status?.state).toBe("completed")
    expect(mock.getCallCount() > 0, "expected HTTP call to mock AI Core").toBeTruthy()
  })

  // ─── Metrics ────────────────────────────────────────────────────────

  it("should record LLM metrics (invocations, input/output tokens) on streaming path", async () => {
    await sendMessage("streaming-metrics", "metrics test")
    const output = await flushMetrics()
    expect(output).toMatch(/agent\.llm\.invocations/)
    expect(output).toMatch(/agent\.llm\.input_tokens/)
    expect(output).toMatch(/agent\.llm\.output_tokens/)
    expect(output).toMatch(/mock-streaming-model/)
  })

  // ─── Audit: AgentDecision ───────────────────────────────────────────

  it("should emit AgentDecision audit event on streaming path", async () => {
    await sendMessage("streaming-metrics", "audit me")
    await wait()

    const decisions = _auditLogs.filter(byEvent("AgentDecision"))
    expect(decisions.length).toBeGreaterThanOrEqual(1)

    const data = decisions[0].data.data
    expect(data.event).toBe("AgentDecision")
    expect(data.model).toBe("mock-streaming-model")
    expect(typeof data.taskId).toBe("string")
    expect(typeof data.duration).toBe("number")
    expect(data.tokenUsage.input_tokens).toBe(10) // from mock AI Core
    expect(data.tokenUsage.output_tokens).toBe(5)
  })

  // ─── Spans ──────────────────────────────────────────────────────────

  it("should create chat span nested under model_request on streaming path", async () => {
    const spans = await getSpansAfterRequest(() => sendMessage("streaming-metrics", "span test"))
    const chatSpan = findSpan(spans, /^chat /)
    expect(chatSpan, "expected chat span").not.toBe(undefined)
    expect(chatSpan.attributes["gen_ai.operation.name"]).toBe("chat")
    expect(chatSpan.attributes["gen_ai.request.model"]).toBe("mock-streaming-model")
    expect(chatSpan.attributes["gen_ai.request.stream"]).toBe(true)
  })

  // ─── Error path ────────────────────────────────────────────────────

  // Skipped: InstrumentedOrchestrationClient uses SDK default retries (6× backoff)
  // which takes >30s on 502. Covered by resilience.test.js (non-streaming path).
  it.skip("should fail task on streaming 5xx", async () => {
    mock.setStatus(502)
    const res = await sendMessage("streaming-metrics", "fail me")
    expect(res.data.result?.status?.state).toBe("failed")
  })
})
