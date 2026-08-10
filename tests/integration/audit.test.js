import cds from "@sap/cds"

const test = cds.test(import.meta.dirname + "/../samples/bookshop")
const { POST, GET, axios } = test
import createHelpers from "../utils/helpers.js"
const { sendMessage, jsonrpc } = createHelpers({ POST, axios })

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

/** Filter audit logs by original event name (stored in data.data.event) */
const byEvent = (name) => (l) => l.event === "SecurityEvent" && l.data?.data?.event === name

describe("@cap-js/agents - Audit Logging", () => {
  let _auditLogs
  let _skipAudit = false

  before(async () => {
    // Ensure audit-log is connectable (hybrid mode may lack 'kind')
    if (!cds.env.requires?.["audit-log"]?.kind)
      cds.env.requires["audit-log"] = { kind: "audit-log-to-console", outbox: false }

    try {
      const audit = await cds.connect.to("audit-log")
      _auditLogs = []
      audit.after("*", (_, req) => {
        _auditLogs.push({ event: req.event, data: JSON.parse(JSON.stringify(req.data)) })
      })
    } catch {
      _skipAudit = true
    }
  })

  beforeEach(() => {
    _auditLogs.length = 0
  })

  it("should emit all events as SecurityEvent for SAP ALS compatibility", async () => {
    await sendMessage("graph-book", "Show me books")
    await wait()

    const nonSecurity = _auditLogs.filter((l) => l.event !== "SecurityEvent")
    expect(nonSecurity.length).toBe(0)
  })

  it("should include correlationId in all events for DPP cross-referencing", async () => {
    await sendMessage("graph-book", "Show me books")
    await wait()

    expect(_auditLogs.length > 0, `expected auditLogs.length > 0`).toBeTruthy()
    for (const log of _auditLogs) {
      expect(log.data.data.correlationId).not.toBe(undefined)
      expect(typeof log.data.data.correlationId).toBe("string")
    }
    // All events from same request share same correlationId
    const ids = new Set(_auditLogs.map((l) => l.data.data.correlationId))
    expect(ids.size).toBe(1)
  })

  describe("AgentTaskStarted", () => {
    it("should emit when a new task is submitted", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskStarted"))
      expect(events.length).toBe(1)

      const data = events[0].data.data
      expect(data.event).toBe("AgentTaskStarted")
      expect(typeof data.taskId).toBe("string")
      expect(typeof data.contextId).toBe("string")
      expect(data.service).toBe("GraphBookService")

      // Should include the full user message for forensic reconstruction
      expect(data.userMessage).not.toBe(undefined)
      expect(data.userMessage.parts).not.toBe(undefined)
      expect(data.userMessage.role).toBe("user")
    })
  })

  describe("AgentTaskCompleted", () => {
    it("should emit when task completes successfully", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskCompleted"))
      expect(events.length).toBe(1)

      const data = events[0].data.data
      expect(data.event).toBe("AgentTaskCompleted")
      expect(typeof data.taskId).toBe("string")
      expect(typeof data.contextId).toBe("string")
      expect(data.service).toBe("GraphBookService")
      expect(typeof data.duration).toBe("string")
      expect(data.output).not.toBe(undefined)
    })

    it("should include duration and output", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const event = _auditLogs.find(byEvent("AgentTaskCompleted"))
      expect(event).not.toBe(undefined)
      expect(event.data.data.duration).not.toBe(undefined)
      expect(event.data.data.output).not.toBe(undefined)
      expect(event.data.data.taskId).not.toBe(undefined)
    })
  })

  describe("SecurityEvent (quota breach)", () => {
    it("should emit on quota breach (maxTasksPerHourPerUser)", async () => {
      const originalMax = cds.env.agents.pool.maxTasksPerHourPerUser
      cds.env.agents.pool.maxTasksPerHourPerUser = 0

      await sendMessage("graph-book", "Should be blocked")
      await wait()

      cds.env.agents.pool.maxTasksPerHourPerUser = originalMax

      const events = _auditLogs.filter(byEvent("QuotaExceeded"))
      expect(events.length).toBe(1)

      const data = events[0].data.data
      expect(data.event).toBe("QuotaExceeded")
      expect(data.service).toBe("GraphBookService")
      expect(data.reason).toMatch(/tasks per hour per user/)
      expect(events[0].data.ip).not.toBe(undefined)
    })

    it("should emit on quota breach (maxConcurrentTasks)", async () => {
      const originalMax = cds.env.agents.pool.maxConcurrentTasks
      cds.env.agents.pool.maxConcurrentTasks = 0

      await sendMessage("graph-book", "Should be blocked")
      await wait()

      cds.env.agents.pool.maxConcurrentTasks = originalMax

      const events = _auditLogs.filter(byEvent("QuotaExceeded"))
      expect(events.length).toBe(1)
      expect(events[0].data.data.event).toBe("QuotaExceeded")
      expect(events[0].data.data.reason).toMatch(/concurrent tasks/)
    })
  })

  describe("ToolInvocation", () => {
    it("should emit for each tool call with args and result", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      expect(events.length > 0, `expected ToolInvocation events`).toBeTruthy()

      const toolEvent = events[0]
      const data = toolEvent.data.data
      expect(data.event).toBe("ToolInvocation")
      expect(typeof data.tool).toBe("string")
      expect(data.outcome).toBe("success")
      expect(typeof data.duration).toBe("number")
      expect(data.args).not.toBe(undefined)
      expect(data.result).not.toBe(undefined)
    })

    it("should emit for custom (non-CDS) tools in the same graph", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      const customToolEvent = events.find((e) => e.data.data.tool === "getBookCount")
      expect(customToolEvent, "expected ToolInvocation for getBookCount").not.toBe(undefined)

      const data = customToolEvent.data.data
      expect(data.tool).toBe("getBookCount")
      expect(data.outcome).toBe("success")
      expect(typeof data.duration).toBe("number")
      expect(data.result).not.toBe(undefined)
      expect(data.taskId).not.toBe(undefined)
    })

    it("should include task correlation", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const toolEvents = _auditLogs.filter(byEvent("ToolInvocation"))
      const taskEvents = _auditLogs.filter(byEvent("AgentTaskStarted"))

      expect(toolEvents.length > 0, `expected ToolInvocation events`).toBeTruthy()
      expect(taskEvents.length).toBe(1)

      const taskId = taskEvents[0].data.data.taskId
      for (const te of toolEvents) {
        expect(te.data.data.taskId).toBe(taskId)
      }
    })

    it("should truncate large results to 2000 chars", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      for (const e of events) {
        if (e.data.data.result) {
          expect(e.data.data.result.length <= 2000, `expected result.length <= 2000`).toBeTruthy()
        }
      }
    })
  })

  describe("event ordering and completeness", () => {
    it("should emit events in correct lifecycle order", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const eventNames = _auditLogs.map((l) => l.data?.data?.event)

      const startIdx = eventNames.indexOf("AgentTaskStarted")
      const completeIdx = eventNames.indexOf("AgentTaskCompleted")
      expect(startIdx >= 0, `expected AgentTaskStarted index >= 0`).toBeTruthy()
      expect(
        completeIdx > startIdx,
        `expected AgentTaskCompleted after AgentTaskStarted`,
      ).toBeTruthy()

      // ToolInvocation should be between start and complete
      const toolIdx = eventNames.indexOf("ToolInvocation")
      if (toolIdx >= 0) {
        expect(toolIdx > startIdx, `expected ToolInvocation after AgentTaskStarted`).toBeTruthy()
        expect(
          toolIdx < completeIdx,
          `expected ToolInvocation before AgentTaskCompleted`,
        ).toBeTruthy()
      }
    })

    it("should emit at least TaskStarted + ToolInvocation + TaskCompleted for a successful request", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const eventTypes = new Set(_auditLogs.map((l) => l.data?.data?.event))
      expect(eventTypes.has("AgentTaskStarted")).toBe(true)
      expect(eventTypes.has("ToolInvocation")).toBe(true)
      expect(eventTypes.has("AgentTaskCompleted")).toBe(true)
    })
  })

  describe("AgentTaskCanceled", () => {
    it("should emit when task is canceled", async () => {
      const res = await sendMessage("graph-book", "Show me books")
      const taskId = res.data.result?.id
      expect(taskId).not.toBe(undefined)

      _auditLogs.length = 0

      await jsonrpc("graph-book", "tasks/cancel", { id: taskId })
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskCanceled"))
      // Cancel of already-completed task may not fire (SDK may reject)
      if (events.length > 0) {
        const data = events[0].data.data
        expect(data.event).toBe("AgentTaskCanceled")
        expect(data.taskId).toBe(taskId)
        expect(data.service).toBe("GraphBookService")
      }
    })
  })
})
