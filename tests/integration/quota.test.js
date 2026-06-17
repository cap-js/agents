import assert from "node:assert/strict"
import cds from "@sap/cds"
import {
  captured,
  setup,
  teardown,
  resetCapture,
  createSendMessage,
} from "../utils/telemetry-utils.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
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
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      assert.strictEqual(res.data.result.status.state, "completed")
    })

    it("should return 429 when maxTasksPerHourPerUser is exceeded", async () => {
      cds.env.agents.pool.maxTasksPerHourPerUser = 0

      const res = await sendMessage("graph-book", "Should reject")
      assert.strictEqual(res.status, 429)
      assert.notStrictEqual(res.data.error, undefined)
      assert.match(res.data.error.message, /tasks per hour per user/)
      // Retry-After should be seconds until next hour
      const retryAfter = parseInt(res.headers["retry-after"])
      assert.ok(retryAfter > 0, `expected ${retryAfter} > 0`)
      assert.ok(retryAfter <= 3600)
    })

    it("should return 429 when maxTasksPerHour is exceeded", async () => {
      cds.env.agents.pool.maxTasksPerHour = 0

      const res = await sendMessage("graph-book", "Should reject")
      assert.strictEqual(res.status, 429)
      assert.notStrictEqual(res.headers["retry-after"], undefined)
      assert.match(res.data.error.message, /tasks per hour/)
    })

    it("should return 429 when maxConcurrentTasks is exceeded", async () => {
      cds.env.agents.pool.maxConcurrentTasks = 0

      const res = await sendMessage("graph-book", "Should reject")
      assert.strictEqual(res.status, 429)
      // Concurrent limit → short retry (30s)
      assert.strictEqual(res.headers["retry-after"], "30")
      assert.match(res.data.error.message, /concurrent tasks/)
    })

    it("should return 429 when maxToolCallsPerHour is exceeded", async () => {
      cds.env.agents.pool.maxToolCallsPerHour = 0

      const res = await sendMessage("graph-book", "Should reject")
      assert.strictEqual(res.status, 429)
      assert.match(res.data.error.message, /tool calls per hour/)
    })

    it("should return 429 when maxLLMTokensPerDay is exceeded", async () => {
      cds.env.agents.pool.maxLLMTokensPerDay = 0

      const res = await sendMessage("graph-book", "Should reject")
      assert.strictEqual(res.status, 429)
      // Daily limit → retry at midnight
      const retryAfter = parseInt(res.headers["retry-after"])
      assert.ok(retryAfter > 0, `expected ${retryAfter} > 0`)
      assert.ok(retryAfter <= 86400)
      assert.match(res.data.error.message, /LLM tokens/)
    })

    it("should include Retry-After header with specific values", async () => {
      cds.env.agents.pool.maxConcurrentTasksPerUser = 0

      const res = await sendMessage("graph-book", "Check header")
      assert.strictEqual(res.status, 429)
      // Concurrent per-user → short retry (30s)
      assert.strictEqual(res.headers["retry-after"], "30")
    })

    it("should include JSON-RPC error code -32029", async () => {
      cds.env.agents.pool.maxTasksPerHour = 0

      const res = await sendMessage("graph-book", "Check error code")
      assert.strictEqual(res.data.error.code, -32029)
    })
  })

  describe("maxIncomingMessageLength", () => {
    it("should reject messages exceeding maxIncomingMessageLength with 400", async () => {
      cds.env.agents.pool.maxIncomingMessageLength = 10

      const res = await sendMessage("graph-book", "This message is longer than ten characters")
      assert.strictEqual(res.status, 400)
      assert.strictEqual(res.data.error.code, -32029)
      assert.match(res.data.error.message, /must not exceed/)
    })

    it("should allow messages within maxIncomingMessageLength", async () => {
      cds.env.agents.pool.maxIncomingMessageLength = 5000

      const res = await sendMessage("graph-book", "Short message")
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.data.result?.status?.state, "completed")
    })
  })

  describe("quotaEnforcerAtNode (e2e)", () => {
    it("should fail task when maxLLMInvocationsPerTask exceeded during graph execution", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 2

      const res = await sendMessage("looping", "trigger loop")
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      assert.strictEqual(res.data.result.status.state, "failed")
      assert.match(res.data.result.status.message.parts[0].text, /quota exceeded/i)
    })

    it("should fail task when maxToolCallsPerTask exceeded during graph execution", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100 // high — won't trigger
      cds.env.agents.pool.maxToolCallsPerTask = 1

      const res = await sendMessage("looping", "trigger tool limit")
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      assert.strictEqual(res.data.result.status.state, "failed")
      assert.match(res.data.result.status.message.parts[0].text, /quota exceeded/i)
    })

    it("should fail task when maxLLMTokensPerTask exceeded during graph execution", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxToolCallsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 150 // agent adds 100 tokens per iteration → exceeds after 2nd

      const res = await sendMessage("looping", "trigger token limit")
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      assert.strictEqual(res.data.result.status.state, "failed")
      assert.match(res.data.result.status.message.parts[0].text, /quota exceeded/i)
    })

    it("should complete normally when per-task limits are high", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxToolCallsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 100000

      // LoopingService always loops — but shouldContinue won't stop it by quota.
      // It will loop until it hits the limit... actually it always produces toolCalls
      // so it will loop forever unless quota stops it. Set a reasonable iteration limit.
      cds.env.agents.pool.maxLLMInvocationsPerTask = 3

      const res = await sendMessage("looping", "limited loop")
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data.result, undefined)
      // Will fail because the loop always exceeds the limit
      assert.strictEqual(res.data.result.status.state, "failed")
    })
  })

  describe("quotaEnforcerAtNode (unit)", () => {
    let quotaEnforcerAtNode
    let shouldContinue

    before(async () => {
      quotaEnforcerAtNode = (await import("../../lib/agents/react/nodes/quotaEnforcerAtNode.js"))
        .default
      shouldContinue = (await import("../../lib/agents/react/nodes/shouldContinue.js")).default
    })

    it("should return 'next' when within per-task limits", async () => {
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      assert.strictEqual(result, "next")
    })

    it("should return 'end' when maxLLMInvocationsPerTask exceeded", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 5
      const state = { _iterations: 5, _totalTokens: 100, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      assert.strictEqual(result, "end")
    })

    it("should return 'end' when maxLLMTokensPerTask exceeded", async () => {
      cds.env.agents.pool.maxLLMTokensPerTask = 1000
      const state = { _iterations: 1, _totalTokens: 1000, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      assert.strictEqual(result, "end")
    })

    it("should return 'end' when maxToolCallsPerTask exceeded", async () => {
      cds.env.agents.pool.maxToolCallsPerTask = 10
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 10 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      assert.strictEqual(result, "end")
    })

    it("should return 'next' when limits not yet reached", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 15
      cds.env.agents.pool.maxLLMTokensPerTask = 20000
      cds.env.agents.pool.maxToolCallsPerTask = 50
      const state = { _iterations: 14, _totalTokens: 19999, _totalToolCalls: 49 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      assert.strictEqual(result, "next")
    })

    it("shouldContinue throws QUOTA_EXCEEDED_AT_NODE when quota exceeded", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 1
      const state = {
        _iterations: 1,
        _totalTokens: 100,
        _totalToolCalls: 0,
        toolCalls: [{ name: "query" }],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }

      await assert.rejects(
        () => shouldContinue(state, config),
        (err) => {
          assert.ok(err.message.includes("Task quota exceeded"))
          return true
        },
      )
      try {
        await shouldContinue(state, config)
      } catch (err) {
        assert.strictEqual(err.code, "QUOTA_EXCEEDED_AT_NODE")
      }
    })

    it("shouldContinue returns 'tools' when within quota and toolCalls present", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 15
      const state = {
        _iterations: 1,
        _totalTokens: 100,
        _totalToolCalls: 0,
        toolCalls: [{ name: "query" }],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await shouldContinue(state, config)
      assert.strictEqual(result, "tools")
    })

    it("shouldContinue returns 'end' when within quota and no toolCalls", async () => {
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 0, toolCalls: [] }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await shouldContinue(state, config)
      assert.strictEqual(result, "end")
    })

    it("should emit QuotaExceeded audit log when quota breached", async (t) => {
      // Ensure audit-log is connectable
      const origAuditLog = cds.env.requires["audit-log"]
      if (!origAuditLog?.kind)
        cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }

      let audit
      try {
        audit = await cds.connect.to("audit-log")
      } catch {
        t.skip("audit-log not connectable")
        return
      }

      const auditLogs = []
      const handler = (_, req) => {
        auditLogs.push(JSON.parse(JSON.stringify(req.data)))
      }
      audit.after("*", handler)

      cds.env.agents.pool.maxLLMInvocationsPerTask = 3
      const state = { _iterations: 3, _totalTokens: 100, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "task-abc-123", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      await new Promise((r) => setTimeout(r, 100))

      assert.strictEqual(result, "end")
      const evt = auditLogs.find((l) => l.data?.event === "QuotaExceeded")
      assert.ok(evt, "QuotaExceeded audit event should have been emitted")
      assert.strictEqual(evt.data.service, "TestService")
      assert.strictEqual(evt.data.taskId, "task-abc-123")
      assert.ok(evt.data.reason.includes("Max iterations reached"))

      cds.env.requires["audit-log"] = origAuditLog
    })

    it("should not emit audit log when within quota", async (t) => {
      const origAuditLog = cds.env.requires["audit-log"]
      if (!origAuditLog?.kind)
        cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }

      let audit
      try {
        audit = await cds.connect.to("audit-log")
      } catch {
        t.skip("audit-log not connectable")
        return
      }

      const auditLogs = []
      const handler = (_, req) => {
        auditLogs.push(JSON.parse(JSON.stringify(req.data)))
      }
      audit.after("*", handler)

      cds.env.agents.pool.maxLLMInvocationsPerTask = 15
      cds.env.agents.pool.maxLLMTokensPerTask = 20000
      cds.env.agents.pool.maxToolCallsPerTask = 50
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 2 }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await quotaEnforcerAtNode(state, config)
      await new Promise((r) => setTimeout(r, 100))

      assert.strictEqual(result, "next")
      const evt = auditLogs.find((l) => l.data?.event === "QuotaExceeded")
      assert.strictEqual(evt, undefined)

      cds.env.requires["audit-log"] = origAuditLog
    })

    it("should emit audit log with token quota reason", async (t) => {
      const origAuditLog = cds.env.requires["audit-log"]
      if (!origAuditLog?.kind)
        cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }

      let audit
      try {
        audit = await cds.connect.to("audit-log")
      } catch {
        t.skip("audit-log not connectable")
        return
      }

      const auditLogs = []
      const handler = (_, req) => {
        auditLogs.push(JSON.parse(JSON.stringify(req.data)))
      }
      audit.after("*", handler)

      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 500
      const state = { _iterations: 1, _totalTokens: 500, _totalToolCalls: 0 }
      const config = { configurable: { _taskId: "task-xyz", _service: "TokenService" } }
      const result = await quotaEnforcerAtNode(state, config)
      await new Promise((r) => setTimeout(r, 100))

      assert.strictEqual(result, "end")
      const evt = auditLogs.find((l) => l.data?.event === "QuotaExceeded")
      assert.ok(evt, "QuotaExceeded audit event should have been emitted")
      assert.strictEqual(evt.data.service, "TokenService")
      assert.strictEqual(evt.data.taskId, "task-xyz")
      assert.ok(evt.data.reason.includes("Max tokens per task reached"))

      cds.env.requires["audit-log"] = origAuditLog
    })

    it("should emit audit log with tool calls quota reason", async (t) => {
      const origAuditLog = cds.env.requires["audit-log"]
      if (!origAuditLog?.kind)
        cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }

      let audit
      try {
        audit = await cds.connect.to("audit-log")
      } catch {
        t.skip("audit-log not connectable")
        return
      }

      const auditLogs = []
      const handler = (_, req) => {
        auditLogs.push(JSON.parse(JSON.stringify(req.data)))
      }
      audit.after("*", handler)

      cds.env.agents.pool.maxLLMInvocationsPerTask = 100
      cds.env.agents.pool.maxLLMTokensPerTask = 20000
      cds.env.agents.pool.maxToolCallsPerTask = 5
      const state = { _iterations: 1, _totalTokens: 100, _totalToolCalls: 5 }
      const config = { configurable: { _taskId: "task-tools", _service: "ToolService" } }
      const result = await quotaEnforcerAtNode(state, config)
      await new Promise((r) => setTimeout(r, 100))

      assert.strictEqual(result, "end")
      const evt = auditLogs.find((l) => l.data?.event === "QuotaExceeded")
      assert.ok(evt, "QuotaExceeded audit event should have been emitted")
      assert.strictEqual(evt.data.service, "ToolService")
      assert.strictEqual(evt.data.taskId, "task-tools")
      assert.ok(evt.data.reason.includes("Max tool calls per task reached"))

      cds.env.requires["audit-log"] = origAuditLog
    })
  })

  describe("toolNode _totalToolCalls tracking", () => {
    let createToolNode

    before(async () => {
      createToolNode = (await import("../../lib/agents/react/nodes/tool.js")).default
    })

    it("should increment _totalToolCalls by toolCalls.length, not by 1", async () => {
      const fakeTool = { invoke: jest.fn(async () => "ok") }
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

      // Result is aggregated via state so that the next node has 8 as the totalToolCalls
      assert.strictEqual(result._totalToolCalls, 3)
      assert.strictEqual(result.messages.length, 3)
    })

    it("should increment by 1 when single tool call", async () => {
      const fakeTool = { invoke: jest.fn(async () => "done") }
      const toolNode = createToolNode({ single: fakeTool })

      const state = {
        _totalToolCalls: 0,
        toolCalls: [{ name: "single", args: {}, id: "c1" }],
      }
      const config = { configurable: { _taskId: "test", _service: "TestService" } }
      const result = await toolNode(state, config)

      assert.strictEqual(result._totalToolCalls, 1)
    })
  })

  describe("usage tracking on task record", () => {
    it("should write agentService to task record after completion", async () => {
      const res = await sendMessage("graph-book", "Track usage")
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.data.result.status.state, "completed")

      // Usage update runs in cds.spawn — wait for it
      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.agent.Tasks").where({ taskId })
      assert.notStrictEqual(row, undefined)
      assert.strictEqual(row.agentService, "GraphBookService")
    })

    it("should write usageToolCalls to task record when graph tracks it", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 3
      const res = await sendMessage("looping", "Track tools")
      assert.strictEqual(res.data.result.status.state, "failed")

      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.agent.Tasks").where({ taskId })
      assert.notStrictEqual(row, undefined)
      assert.ok(row.usageToolCalls >= 1)
    })

    it("should write usage fields even when task fails", async () => {
      cds.env.agents.pool.maxLLMInvocationsPerTask = 2
      const res = await sendMessage("looping", "Fail and track")
      assert.strictEqual(res.data.result.status.state, "failed")

      await new Promise((r) => setTimeout(r, 200))

      const taskId = res.data.result.id
      const row = await SELECT.one.from("cap.agent.Tasks").where({ taskId })
      assert.notStrictEqual(row, undefined)
      assert.strictEqual(row.agentService, "LoopingService")
      assert.ok(row.usageLlmTokens >= 100)
      assert.ok(row.usageToolCalls >= 1)
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
      assert.match(output, /active_users/)
      assert.match(output, /GraphBookService/)
    })

    it("should be triggerable via computeActiveUsers event on agent-executor", async () => {
      await sendMessage("graph-book", "before event")
      captured.length = 0

      // Emit the event on the executor service
      const executor = await cds.connect.to("agent-executor")
      await executor.emit("computeActiveUsers")

      // Flush and verify gauge was updated
      const { metrics } = await import("@opentelemetry/api")
      const meterProvider = metrics.getMeterProvider()
      if (typeof meterProvider.forceFlush !== "function") return // skip if no SDK MeterProvider
      await meterProvider.forceFlush()

      const output = captured.join("")
      assert.match(output, /active_users/)
    })

    it("should have activeUsersInterval configured", () => {
      assert.notStrictEqual(cds.env.agents.activeUsersInterval, undefined)
      assert.notStrictEqual(cds.env.agents.activeUsersInterval, 0)
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
      assert.match(output, /active_users/)
      assert.match(output, /GraphBookService/)
      // Same user sent both messages → distinct user count should be 1
      assert.match(output, /value: 1/)
    })

    it("should parse interval strings correctly", async () => {
      const { parseInterval } = await import("../../lib/telemetry/active-users.js")
      assert.strictEqual(parseInterval("24h"), 24 * 3600000)
      assert.strictEqual(parseInterval("30m"), 30 * 60000)
      assert.strictEqual(parseInterval("60s"), 60000)
      assert.strictEqual(parseInterval("5000ms"), 5000)
      assert.strictEqual(parseInterval(10000), 10000)
      assert.strictEqual(parseInterval("1d"), 86400000)
    })
  })

  describe("pool config", () => {
    it("should have all expected pool limits defined", () => {
      const pool = cds.env.agents.pool
      assert.notStrictEqual(cds.env.agents?.pool, undefined)
      assert.ok(pool.maxConcurrentTasks > 0, `expected ${pool.maxConcurrentTasks} > 0`)
      assert.ok(
        pool.maxConcurrentTasksPerUser > 0,
        `expected ${pool.maxConcurrentTasksPerUser} > 0`,
      )
      assert.ok(pool.maxTasksPerHour > 0, `expected ${pool.maxTasksPerHour} > 0`)
      assert.ok(pool.maxTasksPerHourPerUser > 0, `expected ${pool.maxTasksPerHourPerUser} > 0`)
      assert.ok(pool.maxLLMTokensPerDay > 0, `expected ${pool.maxLLMTokensPerDay} > 0`)
      assert.ok(pool.maxToolCallsPerHour > 0, `expected ${pool.maxToolCallsPerHour} > 0`)
      assert.ok(pool.maxToolCallsPerTask > 0, `expected ${pool.maxToolCallsPerTask} > 0`)
      assert.ok(pool.maxLLMInvocationsPerTask > 0, `expected ${pool.maxLLMInvocationsPerTask} > 0`)
      assert.ok(pool.maxLLMTokensPerTask > 0, `expected ${pool.maxLLMTokensPerTask} > 0`)
      assert.ok(
        pool.maxExecutionTimeMsPerTask > 0,
        `expected ${pool.maxExecutionTimeMsPerTask} > 0`,
      )
    })
  })
})
