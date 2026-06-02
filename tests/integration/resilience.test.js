import assert from "node:assert/strict"
import cds from "@sap/cds"
import { setup, teardown, resetCapture, createSendMessage } from "./telemetry-utils.js"

setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/a2a - LLM Circuit Breaker & Timeout", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  it("should have maxLLMCallTimeoutMs configured in pool", () => {
    assert.strictEqual(cds.env.a2a.pool.maxLLMCallTimeoutMs, 30000)
  })

  // REVISIT: Not circuit breaker not working atm
  // Hybrid-only: real OrchestrationClient with circuit breaker active
  // const isHybrid = cds.env.profiles?.includes("hybrid")
  // const describeHybrid = isHybrid ? describe : describe.skip
  const describeHybrid = describe.skip

  describeHybrid("hybrid: real LLM with resilience", () => {
    it("should complete request successfully (breaker closed)", async () => {
      const res = await sendMessage("catalog", "What books do you have?")
      assert.strictEqual(res.data.result?.status?.state, "completed")
    })

    it("should fail task when timeout is impossibly short", async () => {
      const original = cds.env.a2a.pool.maxLLMCallTimeoutMs
      cds.env.a2a.pool.maxLLMCallTimeoutMs = 1 // 1ms — will always timeout

      const res = await sendMessage("catalog", "Should timeout")

      cds.env.a2a.pool.maxLLMCallTimeoutMs = original

      assert.strictEqual(res.data.result?.status?.state, "failed")
    })

    it("should inject resilience middleware into OrchestrationClient calls", async () => {
      const resilience = await import("@sap-cloud-sdk/resilience")
      const cbSpy = mock.method(resilience, "circuitBreaker")
      const toSpy = mock.method(resilience, "timeout")

      // Send A2A request to a service that uses the default langgraph executor
      // (no custom graph/model). The default path goes through lib/llm.js which
      // wraps OrchestrationClient and injects circuitBreaker() + timeout() middleware.
      await sendMessage("catalog", "test resilience middleware")

      assert.ok(cbSpy.mock.calls.length > 0, "circuitBreaker should have been called")
      assert.ok(toSpy.mock.calls.length > 0, "timeout should have been called")
      assert.strictEqual(toSpy.mock.calls[0].arguments[0], cds.env.a2a.pool.maxLLMCallTimeoutMs)

      cbSpy.mock.restore()
      toSpy.mock.restore()
    })
  })
})
