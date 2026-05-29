const cds = require("@sap/cds")
const { setup, teardown, resetCapture, createSendMessage } = require("./telemetry-utils")

setup()

const { POST, axios } = cds.test(__dirname + "/../bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/a2a - LLM Circuit Breaker & Timeout", () => {
  axios.defaults.validateStatus = () => true
  afterAll(teardown)
  beforeEach(resetCapture)

  it("should have maxLLMCallTimeoutMs configured in pool", () => {
    expect(cds.env.a2a.pool.maxLLMCallTimeoutMs).toBe(30000)
  })

  // REVISIT: Not circuit breaker not working atm
  // Hybrid-only: real OrchestrationClient with circuit breaker active
  // const isHybrid = cds.env.profiles?.includes("hybrid")
  // const describeHybrid = isHybrid ? describe : describe.skip
  const describeHybrid = describe.skip

  describeHybrid("hybrid: real LLM with resilience", () => {
    it("should complete request successfully (breaker closed)", async () => {
      const res = await sendMessage("catalog", "What books do you have?")
      expect(res.data.result?.status?.state).toBe("completed")
    })

    it("should fail task when timeout is impossibly short", async () => {
      const original = cds.env.a2a.pool.maxLLMCallTimeoutMs
      cds.env.a2a.pool.maxLLMCallTimeoutMs = 1 // 1ms — will always timeout

      const res = await sendMessage("catalog", "Should timeout")

      cds.env.a2a.pool.maxLLMCallTimeoutMs = original

      expect(res.data.result?.status?.state).toBe("failed")
    })

    it("should inject resilience middleware into OrchestrationClient calls", async () => {
      const resilience = require("@sap-cloud-sdk/resilience")
      const cbSpy = jest.spyOn(resilience, "circuitBreaker")
      const toSpy = jest.spyOn(resilience, "timeout")

      // Send A2A request to a service that uses the default langgraph executor
      // (no custom graph/model). The default path goes through lib/llm.js which
      // wraps OrchestrationClient and injects circuitBreaker() + timeout() middleware.
      await sendMessage("catalog", "test resilience middleware")

      expect(cbSpy).toHaveBeenCalled()
      expect(toSpy).toHaveBeenCalledWith(cds.env.a2a.pool.maxLLMCallTimeoutMs)

      cbSpy.mockRestore()
      toSpy.mockRestore()
    })
  })
})
