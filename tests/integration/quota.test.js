import cds from "@sap/cds"
import {
  captured,
  setup,
  teardown,
  resetCapture,
  createSendMessage,
} from "../utils/telemetry-utils.js"
import { ms4 } from "../../lib/utils/utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/agents - Quota enforcement", () => {
  axios.defaults.validateStatus = () => true
  after(teardown)
  beforeEach(resetCapture)

  let originalPool

  before(() => {
    originalPool = { ...cds.env.agents.pool }
  })

  afterEach(() => {
    // Restore pool config after each test
    Object.assign(cds.env.agents.pool, originalPool)
  })

  describe("quotaEnforcerAtStart", () => {
    it("should allow request when within quota limits", async () => {
      const res = await sendMessage("graph-book", "Show me books")
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      expect(res.data.result.status.state).toBe("completed")
    })

    it("should return 429 when maxTasksPerHourPerUser is exceeded", async () => {
      cds.env.agents.pool.maxTasksPerHourPerUser = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      expect(res.data.error).not.toBe(undefined)
      expect(res.data.error.message).toMatch(/tasks per hour per user/)
      // Retry-After should be seconds until next hour
      const retryAfter = parseInt(res.headers["retry-after"])
      expect(retryAfter > 0, `expected ${retryAfter} > 0`).toBeTruthy()
      expect(retryAfter <= 3600).toBeTruthy()
    })

    it("should return 429 when maxTasksPerHour is exceeded", async () => {
      cds.env.agents.pool.maxTasksPerHour = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      expect(res.headers["retry-after"]).not.toBe(undefined)
      expect(res.data.error.message).toMatch(/tasks per hour/)
    })

    it("should return 429 when maxConcurrentTasks is exceeded", async () => {
      cds.env.agents.pool.maxConcurrentTasks = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      // Concurrent limit → short retry (30s)
      expect(res.headers["retry-after"]).toBe("30")
      expect(res.data.error.message).toMatch(/concurrent tasks/)
    })

    it("should return 429 when maxToolCallsPerHour is exceeded", async () => {
      cds.env.agents.pool.maxToolCallsPerHour = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      expect(res.data.error.message).toMatch(/tool calls per hour/)
    })

    it("should return 429 when maxLLMTokensPerDay is exceeded", async () => {
      cds.env.agents.pool.maxLLMTokensPerDay = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      // Daily limit → retry at midnight
      const retryAfter = parseInt(res.headers["retry-after"])
      expect(retryAfter > 0, `expected ${retryAfter} > 0`).toBeTruthy()
      expect(retryAfter <= 86400).toBeTruthy()
      expect(res.data.error.message).toMatch(/LLM tokens/)
    })

    it("should include Retry-After header with specific values", async () => {
      cds.env.agents.pool.maxConcurrentTasksPerUser = 0

      const res = await sendMessage("graph-book", "Check header")
      expect(res.status).toBe(429)
      // Concurrent per-user → short retry (30s)
      expect(res.headers["retry-after"]).toBe("30")
    })

    it("should include JSON-RPC error code -32029", async () => {
      cds.env.agents.pool.maxTasksPerHour = 0

      const res = await sendMessage("graph-book", "Check error code")
      expect(res.data.error.code).toBe(-32029)
    })
  })

  describe("maxIncomingMessageLength", () => {
    it("should reject messages exceeding maxIncomingMessageLength with 400", async () => {
      cds.env.agents.pool.maxIncomingMessageLength = 10

      const res = await sendMessage("graph-book", "This message is longer than ten characters")
      expect(res.status).toBe(400)
      expect(res.data.error.code).toBe(-32029)
      expect(res.data.error.message).toMatch(/must not exceed/)
    })

    it("should allow messages within maxIncomingMessageLength", async () => {
      cds.env.agents.pool.maxIncomingMessageLength = 5000

      const res = await sendMessage("graph-book", "Short message")
      expect(res.status).toBe(200)
      expect(res.data.result?.status?.state).toBe("completed")
    })
  })

  describe("quotaEnforcerMiddleware (e2e)", () => {
    it("should cancel task when maxLLMInvocationsPerTask exceeded during graph execution", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 2

      const res = await sendMessage("looping", "trigger loop")
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      expect(res.data.result.status.state).toBe("canceled")
      expect(res.data.result.status.message.parts[0].text).toMatch(/quota exceeded/i)
    })

    it("should cancel task when maxToolCallsPerTask exceeded during graph execution", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100 // high — won't trigger
      cds.env.agents.pool.maxToolCallsPerTask = 1

      const res = await sendMessage("looping", "trigger tool limit")
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      expect(res.data.result.status.state).toBe("canceled")
      expect(res.data.result.status.message.parts[0].text).toMatch(/quota exceeded/i)
    })

    it("should cancel task when maxLLMTokensPerTask exceeded during graph execution", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxToolCallsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 150 // agent adds 100 tokens per iteration → exceeds after 2nd

      const res = await sendMessage("looping", "trigger token limit")
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      expect(res.data.result.status.state).toBe("canceled")
      expect(res.data.result.status.message.parts[0].text).toMatch(/quota exceeded/i)
    })

    it("should cancel when per-task limits are exceeded with looping model", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 3
      cds.env.agents.pool.maxToolCallsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 100000

      const res = await sendMessage("looping", "limited loop")
      expect(res.status).toBe(200)
      expect(res.data.result).not.toBe(undefined)
      // Looping model always exceeds invocation limit → canceled
      expect(res.data.result.status.state).toBe("canceled")
    })
  })

  describe("quotaEnforcerMiddleware (unit)", () => {
    let quotaEnforcerMiddleware

    before(async () => {
      quotaEnforcerMiddleware = (await import("../../lib/agents/middleware/quota-enforcer.js"))
        .quotaEnforcerMiddleware
    })

    it("should return middleware with afterModel hook", async () => {
      const [mw] = await quotaEnforcerMiddleware()
      expect(mw.name).toBe("agentQuotaEnforcerMiddleware")
      expect(mw.afterModel).not.toBe(undefined)
      expect(typeof mw.afterModel.hook).toBe("function")
    })

    it("afterModel hook should throw when maxLLMInvocationsPerTask exceeded", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 2
      const [mw] = await quotaEnforcerMiddleware()
      const { AIMessage } = await import("@langchain/core/messages")
      const state = {
        runModelCallCount: 5,
        runTokenCount: 0,
        runToolCallCount: 0,
        messages: [
          new AIMessage({
            content: "test",
            usage_metadata: { input_tokens: 10, output_tokens: 5 },
          }),
        ],
      }
      expect(() => mw.afterModel.hook(state)).toThrow(/LLM call limit exceeded/)
    })

    it("afterModel hook should throw when maxLLMTokensPerTask exceeded", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 500
      const [mw] = await quotaEnforcerMiddleware()
      const { AIMessage } = await import("@langchain/core/messages")
      const state = {
        runModelCallCount: 0,
        runTokenCount: 600,
        runToolCallCount: 0,
        messages: [
          new AIMessage({
            content: "test",
            usage_metadata: { input_tokens: 10, output_tokens: 5 },
          }),
        ],
      }
      expect(() => mw.afterModel.hook(state)).toThrow(/Token limit exceeded/)
    })

    it("afterModel hook should throw when maxToolCallsPerTask exceeded", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 100000
      cds.env.agents.pool.maxToolCallsPerTask = 5
      const [mw] = await quotaEnforcerMiddleware()
      const { AIMessage } = await import("@langchain/core/messages")
      const state = {
        runModelCallCount: 0,
        runTokenCount: 0,
        runToolCallCount: 10,
        messages: [
          new AIMessage({
            content: "test",
            tool_calls: [{ name: "a" }, { name: "b" }],
            usage_metadata: { input_tokens: 10, output_tokens: 5 },
          }),
        ],
      }
      expect(() => mw.afterModel.hook(state)).toThrow(/Tool call limit exceeded/)
    })

    it("afterModel hook should return updated counts when within limits", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 100000
      cds.env.agents.pool.maxToolCallsPerTask = 100
      const [mw] = await quotaEnforcerMiddleware()
      const { AIMessage } = await import("@langchain/core/messages")
      const state = {
        runModelCallCount: 0,
        runTokenCount: 0,
        runToolCallCount: 0,
        messages: [
          new AIMessage({
            content: "test",
            tool_calls: [{ name: "a" }],
            usage_metadata: { input_tokens: 10, output_tokens: 5 },
          }),
        ],
      }
      const result = mw.afterModel.hook(state)
      expect(result.runModelCallCount).toBe(1)
      expect(result.runTokenCount).toBe(15)
      expect(result.runToolCallCount).toBe(1)
    })
  })

  describe("usage tracking on task record", () => {
    it("should write agentService to task record after completion", async () => {
      const res = await sendMessage("graph-book", "Track usage")
      expect(res.status).toBe(200)
      expect(res.data.result.status.state).toBe("completed")

      // Usage update runs in cds.spawn — wait for it
      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.agent.Tasks").where({ taskId })
      expect(row).not.toBe(undefined)
      expect(row.agentService).toBe("GraphBookService")
    })

    it("should write usageToolCalls to task record when graph tracks it", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 3
      const res = await sendMessage("looping", "Track tools")

      expect(res.data.result.status.state).toBe("canceled")

      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.agent.Tasks").where({ taskId })
      expect(row).not.toBe(undefined)
      expect(row.agentService).toBe("LoopingService")
      expect(
        row.usageToolCalls >= 1,
        `expected usageToolCalls >= 1, got ${row.usageToolCalls}`,
      ).toBeTruthy()
    })

    it("should write usage fields even when task fails", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 2
      const res = await sendMessage("looping", "Fail and track")

      expect(res.data.result.status.state).toBe("canceled")

      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.agent.Tasks").where({ taskId })
      expect(row).not.toBe(undefined)
      expect(row.agentService).toBe("LoopingService")
      expect(
        row.usageLlmTokens >= 100,
        `expected usageLlmTokens >= 100, got ${row.usageLlmTokens}`,
      ).toBeTruthy()
      expect(
        row.usageToolCalls >= 1,
        `expected usageToolCalls >= 1, got ${row.usageToolCalls}`,
      ).toBeTruthy()
    })
  })

  describe("active_users metric", () => {
    it("should compute active users and report gauge via metrics flush", async () => {
      await sendMessage("graph-book", "user activity 1")
      await sendMessage("graph-book", "user activity 2")

      const { computeActiveUsers } = await import("../../lib/telemetry/active-users.js")
      await computeActiveUsers()

      // Flush metrics — ObservableGauge callback should report cached values
      const { metrics } = await import("@opentelemetry/api")
      const meterProvider = metrics.getMeterProvider()
      if (typeof meterProvider.forceFlush !== "function") return // skip if no SDK MeterProvider
      await meterProvider.forceFlush()

      // Captured console output should contain active_users gauge
      const output = captured.join("")
      expect(output).toMatch(/active_users/)
      expect(output).toMatch(/GraphBookService/)
    })

    it("should have activeUsersInterval configured", () => {
      expect(cds.env.agents.activeUsersInterval).not.toBe(undefined)
      expect(cds.env.agents.activeUsersInterval).not.toBe(0)
    })

    it("should count distinct users per service via scheduled cds.spawn", async () => {
      // Create tasks to establish known state
      await sendMessage("graph-book", "from user A")
      await sendMessage("graph-book", "from user A again")

      // setupActiveUsersMetric() was called during server boot with activeUsersInterval "1s"
      // Wait for the cds.spawn periodic job to fire and compute active users
      await new Promise((r) => setTimeout(r, 1500))

      // Flush metrics — the gauge callback (registered by setupActiveUsersMetric) reports values
      const { metrics } = await import("@opentelemetry/api")
      const meterProvider = metrics.getMeterProvider()
      if (typeof meterProvider.forceFlush !== "function") return // skip if no SDK MeterProvider
      captured.length = 0
      await meterProvider.forceFlush()

      const output = captured.join("")
      expect(output).toMatch(/active_users/)
      expect(output).toMatch(/GraphBookService/)
      // Same user sent both messages → distinct user count should be 1
      expect(output).toMatch(/value: 1/)
    })

    it("should parse interval strings correctly", async () => {
      const parseInterval = ms4
      expect(parseInterval("24h")).toBe(24 * 3600000)
      expect(parseInterval("30m")).toBe(30 * 60000)
      expect(parseInterval("60s")).toBe(60000)
      expect(parseInterval("5000ms")).toBe(5000)
      expect(parseInterval(10000)).toBe(10000)
      expect(parseInterval("1d")).toBe(86400000)
      expect(parseInterval("1h")).toBe(3600000)
      expect(parseInterval("1 hour")).toBe(3600000)
      expect(parseInterval("24 hours")).toBe(24 * 3600000)
      expect(parseInterval("24h")).toBe(24 * 3600000)
      expect(parseInterval("1m")).toBe(60000)
      expect(parseInterval("1 minute")).toBe(60000)
      expect(parseInterval("30 minutes")).toBe(30 * 60000)
      expect(parseInterval("30 min")).toBe(30 * 60000)
      expect(parseInterval("60s")).toBe(60000)
      expect(parseInterval("60 seconds")).toBe(60000)
      expect(parseInterval("1 second")).toBe(1000)
      expect(parseInterval("1 sec")).toBe(1000)
      expect(parseInterval("1s")).toBe(1000)
      expect(parseInterval("5000ms")).toBe(5000)
      expect(parseInterval("5000 ms")).toBe(5000)
      expect(parseInterval(10000)).toBe(10000)
      expect(parseInterval("1d")).toBe(86400000)
      expect(parseInterval("1 day")).toBe(86400000)
      expect(parseInterval("2 days")).toBe(2 * 86400000)
      expect(parseInterval("1 week")).toBe(7 * 86400000)
      expect(parseInterval("2 weeks")).toBe(2 * 7 * 86400000)
    })
  })

  describe("pool config", () => {
    it("should have all expected pool limits defined", () => {
      const pool = cds.env.agents.pool
      expect(cds.env.agents?.pool).not.toBe(undefined)
      expect(pool.maxConcurrentTasks > 0, `expected ${pool.maxConcurrentTasks} > 0`).toBeTruthy()
      expect(
        pool.maxConcurrentTasksPerUser > 0,
        `expected ${pool.maxConcurrentTasksPerUser} > 0`,
      ).toBeTruthy()
      expect(pool.maxTasksPerHour > 0, `expected ${pool.maxTasksPerHour} > 0`).toBeTruthy()
      expect(
        pool.maxTasksPerHourPerUser > 0,
        `expected ${pool.maxTasksPerHourPerUser} > 0`,
      ).toBeTruthy()
      expect(pool.maxLLMTokensPerDay > 0, `expected ${pool.maxLLMTokensPerDay} > 0`).toBeTruthy()
      expect(pool.maxToolCallsPerHour > 0, `expected ${pool.maxToolCallsPerHour} > 0`).toBeTruthy()
      expect(pool.maxToolCallsPerTask > 0, `expected ${pool.maxToolCallsPerTask} > 0`).toBeTruthy()
      expect(
        pool.maxLLMInvocationsPerTask > 0,
        `expected ${pool.maxLLMInvocationsPerTask} > 0`,
      ).toBeTruthy()
      expect(pool.maxLLMTokensPerTask > 0, `expected ${pool.maxLLMTokensPerTask} > 0`).toBeTruthy()
      expect(
        pool.maxExecutionTimePerTask,
        `expected maxExecutionTimePerTask to be defined`,
      ).toBeTruthy()
    })
  })
})
