import cds from "@sap/cds"
import { agentConfig } from "../../lib/agents/config.js"
import createHelpers from "../utils/helpers.js"
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/deep-agent")

describe("@cap-js/agents - Quota Enforcer Middleware (deepagents)", () => {
  let sendMessage
  let auditLogs = []
  let pool

  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
    const srv = cds.services.ProductAgentService
    pool = srv.definition["@agent.quota"] = { ...agentConfig(srv, "quota") }

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

  it("should cancel task with summary and emit QuotaExceeded when maxLLMInvocationsPerTask is exceeded", async () => {
    const orig = pool.maxLLMInvocationsPerTask
    pool.maxLLMInvocationsPerTask = 1

    try {
      const res = await sendMessage(
        "product-agent",
        "Calculate bulk pricing for 100 units of every product, then summarize the total cost",
      )
      expect(res.data.result.status.state).toBe("canceled")

      // Wait for async audit emit
      await new Promise((r) => setTimeout(r, 200))

      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/LLM call limit exceeded/)
    } finally {
      pool.maxLLMInvocationsPerTask = orig
    }
  })

  it("should cancel task with summary and emit QuotaExceeded when maxToolCallsPerTask is exceeded", async () => {
    const orig = pool.maxToolCallsPerTask
    pool.maxToolCallsPerTask = 1

    try {
      const res = await sendMessage(
        "product-agent",
        "Show me all products and calculate bulk pricing for Widget Pro at 50 units",
      )
      expect(res.data.result.status.state).toBe("canceled")

      await new Promise((r) => setTimeout(r, 200))

      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/Tool call limit exceeded/)
    } finally {
      pool.maxToolCallsPerTask = orig
    }
  })

  it("should cancel task with summary and emit QuotaExceeded when maxLLMTokensPerTask is exceeded", async () => {
    const orig = pool.maxLLMTokensPerTask
    pool.maxLLMTokensPerTask = 100

    try {
      const res = await sendMessage("product-agent", "Tell me about all your products in detail")

      expect(res.data.result.status.state).toBe("canceled")

      await new Promise((r) => setTimeout(r, 200))

      const quotaEvent = auditLogs.find(
        (l) => l.event === "SecurityEvent" && l.data?.data?.event === "QuotaExceeded",
      )
      expect(quotaEvent, "Should emit QuotaExceeded audit event").toBeTruthy()
      expect(quotaEvent.data.data.reason).toMatch(/Token limit exceeded/)
    } finally {
      pool.maxLLMTokensPerTask = orig
    }
  })
})
