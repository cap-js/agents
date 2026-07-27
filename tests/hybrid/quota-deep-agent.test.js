import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/deep-agent")

describe("@cap-js/agents - Quota Enforcer Middleware (deepagents)", () => {
  let sendMessage
  let auditLogs = []

  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage

    // Capture audit events
    if (!cds.env.requires?.["audit-log"]?.kind)
      cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }
    try {
      const audit = await cds.connect.to("audit-log")
      audit.after("*", (_, req) => {
        auditLogs.push({ event: req.event, data: JSON.parse(JSON.stringify(req.data)) })
      })
    } catch {
      /* audit-log not available */
    }
  })

  beforeEach(() => {
    auditLogs.length = 0
  })

  it("should complete normally when limits are high", async () => {
    const res = await sendMessage("product-agent", "List all products")
    expect(res.data.result.status.state).toBe("completed")
  })

  it("should fail task and emit QuotaExceeded when maxLLMInvocationsPerTask is exceeded", async () => {
    cds.env.agents ??= {}
    cds.env.agents.pool ??= {}
    const orig = cds.env.agents.pool.maxLLMInvocationsPerTask
    cds.env.agents.pool.maxLLMInvocationsPerTask = 1

    try {
      const res = await sendMessage(
        "product-agent",
        "Calculate bulk pricing for 100 units of every product, then summarize the total cost",
      )
      expect(res.data.result.status.state).toBe("failed")

      // Wait for async audit emit
      await new Promise((r) => setTimeout(r, 200))

      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/LLM call limit exceeded/)
    } finally {
      cds.env.agents.pool.maxLLMInvocationsPerTask = orig
    }
  })

  it("should fail task and emit QuotaExceeded when maxToolCallsPerTask is exceeded", async () => {
    cds.env.agents ??= {}
    cds.env.agents.pool ??= {}
    const orig = cds.env.agents.pool.maxToolCallsPerTask
    cds.env.agents.pool.maxToolCallsPerTask = 1

    try {
      const res = await sendMessage(
        "product-agent",
        "Show me all products and calculate bulk pricing for Widget Pro at 50 units",
      )
      expect(res.data.result.status.state).toBe("failed")

      await new Promise((r) => setTimeout(r, 200))

      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/Tool call limit exceeded/)
    } finally {
      cds.env.agents.pool.maxToolCallsPerTask = orig
    }
  })

  it("should fail task and emit QuotaExceeded when maxLLMTokensPerTask is exceeded", async () => {
    cds.env.agents ??= {}
    cds.env.agents.pool ??= {}
    const orig = cds.env.agents.pool.maxLLMTokensPerTask
    cds.env.agents.pool.maxLLMTokensPerTask = 100

    try {
      const res = await sendMessage("product-agent", "Tell me about all your products in detail")
      expect(res.data.result.status.state).toBe("failed")

      await new Promise((r) => setTimeout(r, 200))

      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/Token limit exceeded/)
    } finally {
      cds.env.agents.pool.maxLLMTokensPerTask = orig
    }
  })
})
