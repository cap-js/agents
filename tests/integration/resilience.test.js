import assert from "node:assert/strict"
import cds from "@sap/cds"
import { createRequire } from "node:module"
import { createMockAICore } from "../utils/mock-ai-core.js"

// Start mock AI Core BEFORE cds.test() boots
const mock = createMockAICore()
const mockPort = await mock.start()
process.env.MOCK_AICORE_PORT = String(mockPort)

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { sendMessage } = createHelpers({ POST, axios })

// Access shared circuit breakers map (CJS — same reference as runtime)
const require = createRequire(import.meta.url)
let circuitBreakers
try {
  circuitBreakers = require("@sap-cloud-sdk/resilience/dist/circuit-breaker.js").circuitBreakers
} catch {
  circuitBreakers = null
}

let canLoad = true
try {
  await import("@sap-ai-sdk/langchain")
} catch {
  canLoad = false
}

describe("@cap-js/agents - LLM Circuit Breaker", { skip: !canLoad }, () => {
  axios.defaults.validateStatus = () => true

  let originalQuota
  before(() => {
    originalQuota = cds.env.agent.pool.maxTasksPerHourPerUser
    cds.env.agent.pool.maxTasksPerHourPerUser = 200
  })
  after(() => {
    cds.env.agent.pool.maxTasksPerHourPerUser = originalQuota
    mock.stop()
  })
  beforeEach(() => {
    if (circuitBreakers) {
      for (const key of Object.keys(circuitBreakers)) delete circuitBreakers[key]
    }
    mock.resetCallCount()
    mock.setStatus(200)
  })

  it("should have maxLLMCallTimeoutMs configured", () => {
    assert.strictEqual(cds.env.agent.pool.maxLLMCallTimeoutMs, 120000)
  })

  it("should complete task when AI Core returns 200", async () => {
    const res = await sendMessage("circuit-breaker", "hello")
    assert.strictEqual(res.data.result?.status?.state, "completed")
    assert.ok(mock.getCallCount() > 0, "expected HTTP call to mock")
  })

  it("should fail task when AI Core returns 502", async () => {
    mock.setStatus(502)
    const res = await sendMessage("circuit-breaker", "hello")
    assert.strictEqual(res.data.result?.status?.state, "failed")
  })

  it("should NOT open circuit breaker on 4xx errors (httpErrorFilter)", async () => {
    mock.setStatus(429)
    // volumeThreshold=10 — send 12 to exceed it; 4xx are filtered (don't trip breaker)
    for (let i = 0; i < 12; i++) {
      await sendMessage("circuit-breaker", `rate-limit-${i}`) // eslint-disable-line no-await-in-loop
    }

    mock.resetCallCount()
    mock.setStatus(200)
    const res = await sendMessage("circuit-breaker", "should-succeed-after-429s")
    assert.ok(mock.getCallCount() > 0, "breaker should be closed after 4xx")
    assert.strictEqual(res.data.result?.status?.state, "completed")
  })

  it("should open circuit breaker after repeated 5xx failures", async () => {
    mock.setStatus(502)
    // volumeThreshold=10, errorThreshold=50% → opens after ≥10 failures
    for (let i = 0; i < 11; i++) {
      await sendMessage("circuit-breaker", `trip-${i}`) // eslint-disable-line no-await-in-loop
    }

    mock.resetCallCount()
    await sendMessage("circuit-breaker", "after-open")
    assert.strictEqual(mock.getCallCount(), 0, "breaker open — no HTTP calls expected")
  })

  it("open circuit breaker should cause immediate failure, not timeout from retries", async () => {
    mock.setStatus(502)
    // Trip the breaker
    for (let i = 0; i < 11; i++) {
      await sendMessage("circuit-breaker", `trip-${i}`) // eslint-disable-line no-await-in-loop
    }

    // Breaker open → should fail fast, not retry with exponential backoff.
    // Without fix: pRetry retries EOPENBREAKER 6× with backoff (~30-60s).
    // With fix: onFailedAttempt throws on EOPENBREAKER → immediate abort.
    mock.resetCallCount()
    const t0 = Date.now()
    const res = await sendMessage("circuit-breaker", "should-fail-fast")
    const duration = Date.now() - t0

    assert.strictEqual(res.data.result?.status?.state, "failed")
    assert.strictEqual(mock.getCallCount(), 0, "breaker open — no HTTP calls expected")
    assert.ok(duration < 5000, `Expected fast failure, but took ${duration}ms`)
  })

  it("should recover after circuit breaker state is reset", async () => {
    if (circuitBreakers) {
      for (const key of Object.keys(circuitBreakers)) delete circuitBreakers[key]
    }
    const res = await sendMessage("circuit-breaker", "recovered")
    assert.strictEqual(res.data.result?.status?.state, "completed")
    assert.ok(mock.getCallCount() > 0, "expected HTTP calls after recovery")
  })
})
