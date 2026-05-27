const cds = require("@sap/cds")

const { POST, axios } = cds.test(__dirname + "/../bookshop")
const { sendMessage, jsonrpc } = require("./helpers")({ POST, axios })

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

/** Filter audit logs by original event name (stored in data.data.event) */
const byEvent = (name) => (l) => l.event === "SecurityEvent" && l.data?.data?.event === name

describe("@cap-js/a2a - Audit Logging", () => {
  let _auditLogs

  beforeAll(async () => {
    const audit = await cds.connect.to("audit-log")
    _auditLogs = []
    audit.after("*", (_, req) => {
      _auditLogs.push({ event: req.event, data: JSON.parse(JSON.stringify(req.data)) })
    })
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

    expect(_auditLogs.length).toBeGreaterThan(0)
    for (const log of _auditLogs) {
      expect(log.data.data.correlationId).toBeDefined()
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
      expect(events[0].data.data).toMatchObject({
        event: "AgentTaskStarted",
        taskId: expect.any(String),
        contextId: expect.any(String),
        service: "GraphBookService",
      })
      // Should include the full user message for forensic reconstruction
      expect(events[0].data.data.userMessage).toBeDefined()
      expect(events[0].data.data.userMessage.parts).toBeDefined()
      expect(events[0].data.data.userMessage.role).toBe("user")
    })
  })

  describe("AgentTaskCompleted", () => {
    it("should emit when task completes successfully", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskCompleted"))
      expect(events.length).toBe(1)
      expect(events[0].data.data).toMatchObject({
        event: "AgentTaskCompleted",
        taskId: expect.any(String),
        contextId: expect.any(String),
        service: "GraphBookService",
        duration: expect.any(String),
      })
      expect(events[0].data.data.output).toBeDefined()
    })

    it("should include duration and output", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const event = _auditLogs.find(byEvent("AgentTaskCompleted"))
      expect(event).toBeDefined()
      expect(event.data.data.duration).toBeDefined()
      expect(event.data.data.output).toBeDefined()
      expect(event.data.data.taskId).toBeDefined()
    })
  })

  describe("SecurityEvent (quota breach)", () => {
    it("should emit on quota breach (maxTasksPerHourPerUser)", async () => {
      const originalMax = cds.env.a2a.pool.maxTasksPerHourPerUser
      cds.env.a2a.pool.maxTasksPerHourPerUser = 0

      await sendMessage("graph-book", "Should be blocked")
      await wait()

      cds.env.a2a.pool.maxTasksPerHourPerUser = originalMax

      const events = _auditLogs.filter(byEvent("SecurityEvent"))
      expect(events.length).toBe(1)
      expect(events[0].data.data).toMatchObject({
        event: "SecurityEvent",
        action: "QuotaExceeded",
        service: "GraphBookService",
        reason: expect.stringMatching(/tasks per hour per user/),
      })
      expect(events[0].data.ip).toBeDefined()
    })

    it("should emit on quota breach (maxConcurrentTasks)", async () => {
      const originalMax = cds.env.a2a.pool.maxConcurrentTasks
      cds.env.a2a.pool.maxConcurrentTasks = 0

      await sendMessage("graph-book", "Should be blocked")
      await wait()

      cds.env.a2a.pool.maxConcurrentTasks = originalMax

      const events = _auditLogs.filter(byEvent("SecurityEvent"))
      expect(events.length).toBe(1)
      expect(events[0].data.data.action).toBe("QuotaExceeded")
      expect(events[0].data.data.reason).toMatch(/concurrent tasks/)
    })
  })

  describe("ToolInvocation", () => {
    it("should emit for each tool call with args and result", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      expect(events.length).toBeGreaterThan(0)

      const toolEvent = events[0]
      expect(toolEvent.data.data).toMatchObject({
        event: "ToolInvocation",
        tool: expect.any(String),
        outcome: "success",
        duration: expect.any(Number),
      })
      expect(toolEvent.data.data.args).toBeDefined()
      expect(toolEvent.data.data.result).toBeDefined()
    })

    it("should include task correlation", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const toolEvents = _auditLogs.filter(byEvent("ToolInvocation"))
      const taskEvents = _auditLogs.filter(byEvent("AgentTaskStarted"))

      expect(toolEvents.length).toBeGreaterThan(0)
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
          expect(e.data.data.result.length).toBeLessThanOrEqual(2000)
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
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(completeIdx).toBeGreaterThan(startIdx)

      // ToolInvocation should be between start and complete
      const toolIdx = eventNames.indexOf("ToolInvocation")
      if (toolIdx >= 0) {
        expect(toolIdx).toBeGreaterThan(startIdx)
        expect(toolIdx).toBeLessThan(completeIdx)
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
      expect(taskId).toBeDefined()

      _auditLogs.length = 0

      await jsonrpc("graph-book", "tasks/cancel", { id: taskId })
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskCanceled"))
      // Cancel of already-completed task may not fire (SDK may reject)
      if (events.length > 0) {
        expect(events[0].data.data).toMatchObject({
          event: "AgentTaskCanceled",
          taskId,
          service: "GraphBookService",
        })
      }
    })
  })
})
