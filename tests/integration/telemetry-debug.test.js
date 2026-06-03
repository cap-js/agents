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
  createSendMessage,
} from "../utils/telemetry-utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../telemetry-debug")
const sendMessage = createSendMessage(POST)

describe("@cap-js/a2a - Debug tracing & error handling", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  // ─── trace_langchain = false ────────────────────────────────────────

  describe("trace_langchain disabled", () => {
    it("should NOT patch BaseChatModel when trace_langchain is false", async () => {
      assert.strictEqual(cds.env.a2a.trace_langchain, false)
      const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
      const PATCHED = Symbol.for("@cap-js/a2a:patched")
      assert.strictEqual(BaseChatModel.prototype[PATCHED], undefined)
    })

    it("should NOT patch StructuredTool when trace_langchain is false", async () => {
      const { StructuredTool } = await import("@langchain/core/tools")
      const PATCHED = Symbol.for("@cap-js/a2a:patched")
      assert.strictEqual(StructuredTool.prototype[PATCHED], undefined)
    })

    it("should NOT patch RunnableLambda when trace_langchain is false", async () => {
      const { RunnableLambda } = await import("@langchain/core/runnables")
      const PATCHED = Symbol.for("@cap-js/a2a:patched")
      assert.strictEqual(RunnableLambda.prototype[PATCHED], undefined)
    })
  })

  // ─── Debug content capture ──────────────────────────────────────────

  describe("debug content on spans", () => {
    it("should include a2a.entity.input on tool spans when log level is debug", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "Show books"))
      const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")
      assert.notStrictEqual(toolSpan, undefined)
      assert.notStrictEqual(toolSpan.attributes["a2a.entity.input"], undefined)
      assert.match(toolSpan.attributes["a2a.entity.input"], /Books/)
    })

    it("should include a2a.entity.output on tool spans when log level is debug", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "List books"))
      const toolSpan = findSpan(spans, "execute_tool DynamicStructuredTool query")
      assert.notStrictEqual(toolSpan, undefined)
      assert.notStrictEqual(toolSpan.attributes["a2a.entity.output"], undefined)
      assert.match(toolSpan.attributes["a2a.entity.output"], /Wuthering Heights|Jane Eyre/)
    })
  })

  // ─── Failing graph (a2a.errors.total) ───────────────────────────────

  describe("failing graph", () => {
    it("should return failed state when graph throws", async () => {
      const res = await sendMessage("debug", "Please fail now")
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      assert.strictEqual(res.data.result.status.state, "failed")
      assert.match(res.data.result.status.message.parts[0].text, /Simulated graph failure/)
    })

    it("should record a2a.errors.total metric on graph failure", async () => {
      await sendMessage("debug", "fail for metrics")
      const output = await flushMetrics()
      assert.match(output, /a2a\.errors\.total/)
      assert.match(output, /execution_failed/)
    })

    it("should set a2a.outcome=failed on workflow span when graph throws", async () => {
      const spans = await getSpansAfterRequest(() => sendMessage("debug", "fail for span"))
      const wfSpan = findSpan(spans, "workflow CompiledStateGraph DebugService")
      assert.notStrictEqual(wfSpan, undefined)
      assert.strictEqual(wfSpan.attributes["a2a.outcome"], "failed")
      assert.strictEqual(wfSpan.status.code, 2)
    })
  })
})
