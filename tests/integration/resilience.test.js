import cds from "@sap/cds"
import { createMockAICore } from "../utils/mock-ai-core.js"

// Start mock AI Core BEFORE cds.test() boots
const mock = createMockAICore()
const mockPort = await mock.start()
process.env.MOCK_AICORE_PORT = String(mockPort)

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
import createHelpers from "../utils/helpers.js"
const { sendMessage } = createHelpers({ POST, axios })

describe("@cap-js/agents - LLM Circuit Breaker", () => {
  axios.defaults.validateStatus = () => true

  // Reset the server-side circuit breaker state via a test-only OData action so
  // each test starts with closed breakers and we never wait out resetTimeout.
  const resetBreakers = () => POST("/odata/v4/circuit-breaker/resetBreakers", {})

  after(() => {
    mock.stop()
  })
  beforeEach(async () => {
    await resetBreakers()
    mock.resetCallCount()
    mock.setStatus(200)
  })

  it("should complete task when AI Core returns 200", async () => {
    const res = await sendMessage("circuit-breaker", "hello")
    expect(res.data.result?.status?.state).toBe("completed")
    expect(mock.getCallCount() > 0, "expected HTTP call to mock").toBeTruthy()
  })

  it("should fail task when AI Core returns 502", async () => {
    mock.setStatus(502)
    const res = await sendMessage("circuit-breaker", "hello")
    expect(res.data.result?.status?.state).toBe("failed")
  })

  it("should NOT open circuit breaker on 4xx errors (httpErrorFilter)", async () => {
    mock.setStatus(429)
    // volumeThreshold=2, send 4 to exceed it. 4xx are filtered (don't trip breaker).
    for (let i = 0; i < 4; i++) {
      await sendMessage("circuit-breaker", `rate-limit-${i}`) // eslint-disable-line no-await-in-loop
    }

    mock.resetCallCount()
    mock.setStatus(200)
    const res = await sendMessage("circuit-breaker", "should-succeed-after-429s")
    expect(mock.getCallCount() > 0, "breaker should be closed after 4xx").toBeTruthy()
    expect(res.data.result?.status?.state).toBe("completed")
  })

  it("should open circuit breaker after repeated 5xx failures", async () => {
    mock.setStatus(502)
    // volumeThreshold=2, errorThreshold=50% → opens after ≥2 failures
    for (let i = 0; i < 3; i++) {
      await sendMessage("circuit-breaker", `trip-${i}`) // eslint-disable-line no-await-in-loop
    }

    mock.resetCallCount()
    await sendMessage("circuit-breaker", "after-open")
    expect(mock.getCallCount(), "breaker open — no HTTP calls expected").toBe(0)
  })

  it("open circuit breaker should cause immediate failure, not timeout from retries", async () => {
    mock.setStatus(502)
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await sendMessage("circuit-breaker", `trip-${i}`) // eslint-disable-line no-await-in-loop
    }

    // Breaker open → should fail fast, not retry with exponential backoff.
    // Without fix: pRetry retries EOPENBREAKER 6× with backoff (~30-60s).
    // With fix: onFailedAttempt throws on EOPENBREAKER → immediate abort.
    mock.resetCallCount()
    const t0 = Date.now()
    const res = await sendMessage("circuit-breaker", "should-fail-fast")
    const duration = Date.now() - t0

    expect(res.data.result?.status?.state).toBe("failed")
    expect(mock.getCallCount(), "breaker open — no HTTP calls expected").toBe(0)
    expect(duration < 5000, `Expected fast failure, but took ${duration}ms`).toBeTruthy()
  })

  it("should recover after circuit breaker state is reset", async () => {
    mock.setStatus(502)
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await sendMessage("circuit-breaker", `trip-${i}`) // eslint-disable-line no-await-in-loop
    }

    // Reset breaker state directly instead of waiting out resetTimeout.
    await resetBreakers()
    mock.setStatus(200)
    mock.resetCallCount()

    const res = await sendMessage("circuit-breaker", "recovered")
    expect(res.data.result?.status?.state).toBe("completed")
    expect(mock.getCallCount() > 0, "expected HTTP calls after recovery").toBeTruthy()
  })
})
