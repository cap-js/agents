import cds from "@sap/cds"
import {
  captured,
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpansAfterRequest,
  findSpan,
  createSendMessage,
} from "../utils/telemetry-utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/telemetry-debug")
const sendMessage = createSendMessage(POST)

describe("@cap-js/agents - Debug tracing & error handling", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  // ─── trace_langchain = false ────────────────────────────────────────

  describe("trace_langchain disabled", () => {
    it("should NOT patch BaseChatModel when trace_langchain is false", async () => {
      expect(cds.env.agents.trace_langchain).toBe(false)
      const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
      const PATCHED = Symbol.for("@cap-js/agents:patched")
      expect(BaseChatModel.prototype[PATCHED]).toBe(undefined)
    })

    it("should NOT patch StructuredTool when trace_langchain is false", async () => {
      const { StructuredTool } = await import("@langchain/core/tools")
      const PATCHED = Symbol.for("@cap-js/agents:patched")
      expect(StructuredTool.prototype[PATCHED]).toBe(undefined)
    })

    it("should NOT patch RunnableLambda when trace_langchain is false", async () => {
      const { RunnableLambda } = await import("@langchain/core/runnables")
      const PATCHED = Symbol.for("@cap-js/agents:patched")
      expect(RunnableLambda.prototype[PATCHED]).toBe(undefined)
    })
  })

  // ─── Debug content capture ──────────────────────────────────────────

  describe("debug content on spans", () => {
    it("should include gen_ai.tool.call.arguments on tool spans when log level is debug", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "Show books"))
      const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")
      expect(toolSpan).not.toBe(undefined)
      expect(toolSpan.attributes["gen_ai.tool.call.arguments"]).not.toBe(undefined)
      expect(toolSpan.attributes["gen_ai.tool.call.arguments"]).toMatch(/Books/)
    })

    it("should include gen_ai.tool.call.result on tool spans when log level is debug", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "List books"))
      const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")
      expect(toolSpan).not.toBe(undefined)
      expect(toolSpan.attributes["gen_ai.tool.call.result"]).not.toBe(undefined)
      expect(toolSpan.attributes["gen_ai.tool.call.result"]).toMatch(/Wuthering Heights|Jane Eyre/)
    })
  })

  // ─── Failing graph (agent.errors.total) ───────────────────────────────

  describe("failing graph", () => {
    it("should return failed state when graph throws", async () => {
      const res = await sendMessage("debug", "Please fail now")
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      expect(res.data.result.status.state).toBe("failed")
      expect(res.data.result.status.message.parts[0].text).toMatch(/Simulated graph failure/)
    })

    it("should record agent.errors.total metric on graph failure", async () => {
      await sendMessage("debug", "fail for metrics")
      const output = await flushMetrics()
      expect(output).toMatch(/agent\.errors\.total/)
      expect(output).toMatch(/execution_failed/)
    })

    it("should set agent.outcome=failed on workflow span when graph throws", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "fail for span"))
      const wfSpan = findSpan(spans, "workflow CompiledStateGraph DebugService")
      expect(wfSpan).not.toBe(undefined)
      expect(wfSpan.attributes["agent.outcome"]).toBe("failed")
      expect(wfSpan.status.code).toBe(2)
    })
  })
})
