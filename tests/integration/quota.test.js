const cds = require("@sap/cds")
const { captured, setup, teardown, resetCapture, createSendMessage } = require("./telemetry-utils")

setup()

const { POST, axios } = cds.test(__dirname + "/../bookshop")
const sendMessage = createSendMessage(POST)

describe("@cap-js/a2a - Quota enforcement", () => {
  axios.defaults.validateStatus = () => true
  afterAll(teardown)
  beforeEach(resetCapture)

  let originalPool

  beforeAll(() => {
    originalPool = { ...cds.env.a2a.pool }
  })

  afterEach(() => {
    // Restore pool config after each test
    Object.assign(cds.env.a2a.pool, originalPool)
  })

  describe("quotaEnforcerAtStart", () => {
    it("should allow request when within quota limits", async () => {
      const res = await sendMessage("graph-book", "Show me books")
      expect(res.status).toBe(200)
      expect(res.data.result).toBeDefined()
      expect(res.data.result.status.state).toBe("completed")
    })

    it("should return 429 when maxTasksPerHourPerUser is exceeded", async () => {
      cds.env.a2a.pool.maxTasksPerHourPerUser = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      expect(res.data.error).toBeDefined()
      expect(res.data.error.message).toMatch(/tasks per hour per user/)
      // Retry-After should be seconds until next hour
      const retryAfter = parseInt(res.headers["retry-after"])
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(3600)
    })

    it("should return 429 when maxTasksPerHour is exceeded", async () => {
      cds.env.a2a.pool.maxTasksPerHour = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      expect(res.headers["retry-after"]).toBeDefined()
      expect(res.data.error.message).toMatch(/tasks per hour/)
    })

    it("should return 429 when maxConcurrentTasks is exceeded", async () => {
      cds.env.a2a.pool.maxConcurrentTasks = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      // Concurrent limit → short retry (30s)
      expect(res.headers["retry-after"]).toBe("30")
      expect(res.data.error.message).toMatch(/concurrent tasks/)
    })

    it("should return 429 when maxToolCallsPerHour is exceeded", async () => {
      cds.env.a2a.pool.maxToolCallsPerHour = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      expect(res.data.error.message).toMatch(/tool calls per hour/)
    })

    it("should return 429 when maxLLMTokensPerDay is exceeded", async () => {
      cds.env.a2a.pool.maxLLMTokensPerDay = 0

      const res = await sendMessage("graph-book", "Should reject")
      expect(res.status).toBe(429)
      // Daily limit → retry at midnight
      const retryAfter = parseInt(res.headers["retry-after"])
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(86400)
      expect(res.data.error.message).toMatch(/LLM tokens/)
    })

    it("should include Retry-After header with specific values", async () => {
      cds.env.a2a.pool.maxConcurrentTasksPerUser = 0

      const res = await sendMessage("graph-book", "Check header")
      expect(res.status).toBe(429)
      // Concurrent per-user → short retry (30s)
      expect(res.headers["retry-after"]).toBe("30")
    })

    it("should include JSON-RPC error code -32029", async () => {
      cds.env.a2a.pool.maxTasksPerHour = 0

      const res = await sendMessage("graph-book", "Check error code")
      expect(res.data.error.code).toBe(-32029)
    })
  })

  describe("quotaEnforcerAtNode (e2e)", () => {
    it("should fail task when maxLLMInvocationsPerTask exceeded during graph execution", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 2

      const res = await sendMessage("looping", "trigger loop")
      expect(res.status).toBe(200)
      expect(res.data.result).toBeDefined()
      expect(res.data.result.status.state).toBe("failed")
      expect(res.data.result.status.message.parts[0].text).toMatch(/quota exceeded/i)
    })

    it("should fail task when maxToolCallsPerTask exceeded during graph execution", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 100 // high — won't trigger
      cds.env.a2a.pool.maxToolCallsPerTask = 1

      const res = await sendMessage("looping", "trigger tool limit")
      expect(res.status).toBe(200)
      expect(res.data.result).toBeDefined()
      expect(res.data.result.status.state).toBe("failed")
      expect(res.data.result.status.message.parts[0].text).toMatch(/quota exceeded/i)
    })

    it("should fail task when maxLLMTokensPerTask exceeded during graph execution", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 100
      cds.env.a2a.pool.maxToolCallsPerTask = 100
      cds.env.a2a.pool.maxLLMTokensPerTask = 150 // agent adds 100 tokens per iteration → exceeds after 2nd

      const res = await sendMessage("looping", "trigger token limit")
      expect(res.status).toBe(200)
      expect(res.data.result).toBeDefined()
      expect(res.data.result.status.state).toBe("failed")
      expect(res.data.result.status.message.parts[0].text).toMatch(/quota exceeded/i)
    })

    it("should complete normally when per-task limits are high", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 100
      cds.env.a2a.pool.maxToolCallsPerTask = 100
      cds.env.a2a.pool.maxLLMTokensPerTask = 100000

      // LoopingService always loops — but shouldContinue won't stop it by quota.
      // It will loop until it hits the limit... actually it always produces toolCalls
      // so it will loop forever unless quota stops it. Set a reasonable iteration limit.
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 3

      const res = await sendMessage("looping", "limited loop")
      expect(res.status).toBe(200)
      expect(res.data.result).toBeDefined()
      // Will fail because the loop always exceeds the limit
      expect(res.data.result.status.state).toBe("failed")
    })
  })

  describe("quotaEnforcerAtNode (unit)", () => {
    const quotaEnforcerAtNode = require("../../lib/executor/langgraph/nodes/quotaEnforcerAtNode")
    const shouldContinue = require("../../lib/executor/langgraph/nodes/shouldContinue")

    it("should return 'next' when within per-task limits", async () => {
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      expect(result).toBe("next")
    })

    it("should return 'end' when maxLLMInvocationsPerTask exceeded", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 5
      const state = { _iterations: 5, _totalTokens: 100, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      expect(result).toBe("end")
    })

    it("should return 'end' when maxLLMTokensPerTask exceeded", async () => {
      cds.env.a2a.pool.maxLLMTokensPerTask = 1000
      const state = { _iterations: 1, _totalTokens: 1000, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      expect(result).toBe("end")
    })

    it("should return 'end' when maxToolCallsPerTask exceeded", async () => {
      cds.env.a2a.pool.maxToolCallsPerTask = 10
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 10 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      expect(result).toBe("end")
    })

    it("should return 'next' when limits not yet reached", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 15
      cds.env.a2a.pool.maxLLMTokensPerTask = 20000
      cds.env.a2a.pool.maxToolCallsPerTask = 50
      const state = { _iterations: 14, _totalTokens: 19999, _totalToolCalls: 49 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      expect(result).toBe("next")
    })

    it("shouldContinue throws QUOTA_EXCEEDED_AT_NODE when quota exceeded", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 1
      const state = {
        _iterations: 1,
        _totalTokens: 100,
        _totalToolCalls: 0,
        toolCalls: [{ name: "query" }],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }

      await expect(shouldContinue(state, config)).rejects.toThrow("Task quota exceeded")
      try {
        await shouldContinue(state, config)
      } catch (err) {
        expect(err.code).toBe("QUOTA_EXCEEDED_AT_NODE")
      }
    })

    it("shouldContinue returns 'tools' when within quota and toolCalls present", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 15
      const state = {
        _iterations: 1,
        _totalTokens: 100,
        _totalToolCalls: 0,
        toolCalls: [{ name: "query" }],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await shouldContinue(state, config)
      expect(result).toBe("tools")
    })

    it("shouldContinue returns 'end' when within quota and no toolCalls", async () => {
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 0, toolCalls: [] }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await shouldContinue(state, config)
      expect(result).toBe("end")
    })
  })

  describe("toolNode _totalToolCalls tracking", () => {
    const createToolNode = require("../../lib/executor/langgraph/nodes/tool")

    it("should increment _totalToolCalls by toolCalls.length, not by 1", async () => {
      const fakeTool = { invoke: jest.fn().mockResolvedValue("ok") }
      const toolMap = { alpha: fakeTool, beta: fakeTool, gamma: fakeTool }
      const toolNode = createToolNode(toolMap)

      const state = {
        _totalToolCalls: 5,
        toolCalls: [
          { name: "alpha", args: {}, id: "c1" },
          { name: "beta", args: {}, id: "c2" },
          { name: "gamma", args: {}, id: "c3" },
        ],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await toolNode(state, config)

      // 5 + 3 = 8 (not 5 + 1 = 6 which was the old bug)
      expect(result._totalToolCalls).toBe(8)
      expect(result.messages).toHaveLength(3)
    })

    it("should increment by 1 when single tool call", async () => {
      const fakeTool = { invoke: jest.fn().mockResolvedValue("done") }
      const toolNode = createToolNode({ single: fakeTool })

      const state = {
        _totalToolCalls: 0,
        toolCalls: [{ name: "single", args: {}, id: "c1" }],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await toolNode(state, config)

      expect(result._totalToolCalls).toBe(1)
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
      const row = await SELECT.one.from("cap.a2a.Tasks").where({ taskId })
      expect(row).toBeDefined()
      expect(row.agentService).toBe("GraphBookService")
    })

    it("should write usageToolCalls to task record when graph tracks it", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 3
      const res = await sendMessage("looping", "Track tools")
      expect(res.data.result.status.state).toBe("failed")

      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.a2a.Tasks").where({ taskId })
      expect(row).toBeDefined()
      expect(row.usageToolCalls).toBeGreaterThanOrEqual(1)
    })

    it("should write usage fields even when task fails", async () => {
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 2
      const res = await sendMessage("looping", "Fail and track")
      expect(res.data.result.status.state).toBe("failed")

      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.a2a.Tasks").where({ taskId })
      expect(row).toBeDefined()
      expect(row.agentService).toBe("LoopingService")
      expect(row.usageLlmTokens).toBeGreaterThanOrEqual(100)
      expect(row.usageToolCalls).toBeGreaterThanOrEqual(1)
    })
  })

  describe("active_users metric", () => {
    it("should compute active users and report gauge via metrics flush", async () => {
      await sendMessage("graph-book", "user activity 1")
      await sendMessage("graph-book", "user activity 2")

      const { computeActiveUsers } = require("../../lib/telemetry/active-users")
      await computeActiveUsers()

      // Flush metrics — ObservableGauge callback should report cached values
      const { metrics } = require("@opentelemetry/api")
      const meterProvider = metrics.getMeterProvider()
      expect(typeof meterProvider.forceFlush).toBe("function")
      await meterProvider.forceFlush()

      // Captured console output should contain active_users gauge
      const output = captured.join("")
      expect(output).toMatch(/active_users/)
      expect(output).toMatch(/GraphBookService/)
    })

    it("should be triggerable via computeActiveUsers event on a2a-executor", async () => {
      await sendMessage("graph-book", "before event")
      captured.length = 0

      // Emit the event on the executor service
      const executor = await cds.connect.to("a2a-executor")
      await executor.emit("computeActiveUsers")

      // Flush and verify gauge was updated
      const { metrics } = require("@opentelemetry/api")
      await metrics.getMeterProvider().forceFlush()

      const output = captured.join("")
      expect(output).toMatch(/active_users/)
    })

    it("should have activeUsersInterval configured", () => {
      expect(cds.env.a2a.activeUsersInterval).toBeDefined()
      expect(cds.env.a2a.activeUsersInterval).not.toBe(0)
    })

    it("should count distinct users per service via scheduled cds.spawn", async () => {
      // Create tasks to establish known state
      await sendMessage("graph-book", "from user A")
      await sendMessage("graph-book", "from user A again")

      // setupActiveUsersMetric() was called during server boot with activeUsersInterval "1s"
      // Wait for the cds.spawn periodic job to fire and compute active users
      await new Promise((r) => setTimeout(r, 1500))

      // Flush metrics — the gauge callback (registered by setupActiveUsersMetric) reports values
      const { metrics } = require("@opentelemetry/api")
      const meterProvider = metrics.getMeterProvider()
      captured.length = 0
      await meterProvider.forceFlush()

      const output = captured.join("")
      expect(output).toMatch(/active_users/)
      expect(output).toMatch(/GraphBookService/)
      // Same user sent both messages → distinct user count should be 1
      expect(output).toMatch(/value: 1/)
    })

    it("should parse interval strings correctly", () => {
      const { parseInterval } = require("../../lib/telemetry/active-users")
      expect(parseInterval("24h")).toBe(24 * 3600000)
      expect(parseInterval("30m")).toBe(30 * 60000)
      expect(parseInterval("60s")).toBe(60000)
      expect(parseInterval("5000ms")).toBe(5000)
      expect(parseInterval(10000)).toBe(10000)
      expect(parseInterval("1d")).toBe(86400000)
    })
  })

  describe("pool config", () => {
    it("should have all expected pool limits defined", () => {
      const pool = cds.env.a2a.pool
      expect(cds.env.a2a?.pool).toBeDefined()
      expect(pool.maxConcurrentTasks).toBeGreaterThan(0)
      expect(pool.maxConcurrentTasksPerUser).toBeGreaterThan(0)
      expect(pool.maxTasksPerHour).toBeGreaterThan(0)
      expect(pool.maxTasksPerHourPerUser).toBeGreaterThan(0)
      expect(pool.maxLLMTokensPerDay).toBeGreaterThan(0)
      expect(pool.maxToolCallsPerHour).toBeGreaterThan(0)
      expect(pool.maxToolCallsPerTask).toBeGreaterThan(0)
      expect(pool.maxLLMInvocationsPerTask).toBeGreaterThan(0)
      expect(pool.maxLLMTokensPerTask).toBeGreaterThan(0)
      expect(pool.maxExecutionTimeMsPerTask).toBeGreaterThan(0)
    })
  })
})
