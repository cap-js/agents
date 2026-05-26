const cds = require("@sap/cds")
const {
  captured,
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpansAfterRequest,
  findSpan,
  createSendMessage,
} = require("./telemetry-utils")

setup()

const { POST, axios } = cds.test(__dirname + "/../telemetry-debug")
const sendMessage = createSendMessage(POST)

describe("@cap-js/a2a - Debug tracing & error handling", () => {
  axios.defaults.validateStatus = () => true
  afterAll(teardown)
  beforeEach(resetCapture)

  // ─── trace_langchain = false ────────────────────────────────────────

  describe("trace_langchain disabled", () => {
    it("should NOT patch BaseChatModel when trace_langchain is false", () => {
      expect(cds.env.a2a.trace_langchain).toBe(false)
      const { BaseChatModel } = require("@langchain/core/language_models/chat_models")
      const PATCHED = Symbol.for("@cap-js/a2a:patched")
      expect(BaseChatModel.prototype[PATCHED]).toBeUndefined()
    })

    it("should NOT patch StructuredTool when trace_langchain is false", () => {
      const { StructuredTool } = require("@langchain/core/tools")
      const PATCHED = Symbol.for("@cap-js/a2a:patched")
      expect(StructuredTool.prototype[PATCHED]).toBeUndefined()
    })

    it("should NOT patch RunnableLambda when trace_langchain is false", () => {
      const { RunnableLambda } = require("@langchain/core/runnables")
      const PATCHED = Symbol.for("@cap-js/a2a:patched")
      expect(RunnableLambda.prototype[PATCHED]).toBeUndefined()
    })
  })

  // ─── Debug content capture ──────────────────────────────────────────

  describe("debug content on spans", () => {
    it("should include a2a.entity.input on tool spans when log level is debug", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "Show books"))
      const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")
      expect(toolSpan).toBeDefined()
      expect(toolSpan.attributes["a2a.entity.input"]).toBeDefined()
      expect(toolSpan.attributes["a2a.entity.input"]).toMatch(/Books/)
    })

    it("should include a2a.entity.output on tool spans when log level is debug", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "List books"))
      const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")
      expect(toolSpan).toBeDefined()
      expect(toolSpan.attributes["a2a.entity.output"]).toBeDefined()
      expect(toolSpan.attributes["a2a.entity.output"]).toMatch(/Wuthering Heights|Jane Eyre/)
    })
  })

  // ─── Failing graph (a2a.errors.total) ───────────────────────────────

  describe("failing graph", () => {
    it("should return failed state when graph throws", async () => {
      const res = await sendMessage("debug", "Please fail now")
      expect(res.status).toBe(200)
      expect(res.data.result).toBeDefined()
      expect(res.data.result.status.state).toBe("failed")
      expect(res.data.result.status.message.parts[0].text).toMatch(/Simulated graph failure/)
    })

    it("should record a2a.errors.total metric on graph failure", async () => {
      await sendMessage("debug", "fail for metrics")
      const output = await flushMetrics()
      expect(output).toMatch(/a2a\.errors\.total/)
      expect(output).toMatch(/execution_failed/)
    })

    it("should set a2a.outcome=failed on workflow span when graph throws", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "fail for span"))
      const wfSpan = findSpan(spans, "workflow CompiledStateGraph DebugService")
      expect(wfSpan).toBeDefined()
      expect(wfSpan.attributes["a2a.outcome"]).toBe("failed")
      expect(wfSpan.status.code).toBe(2)
    })
  })
})
