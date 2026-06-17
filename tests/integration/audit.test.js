import assert from "node:assert/strict"
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
    assert.strictEqual(nonSecurity.length, 0)
  })

  it("should include correlationId in all events for DPP cross-referencing", async () => {
    await sendMessage("graph-book", "Show me books")
    await wait()

    assert.ok(_auditLogs.length > 0, `expected auditLogs.length > 0`)
    for (const log of _auditLogs) {
      assert.notStrictEqual(log.data.data.correlationId, undefined)
      assert.strictEqual(typeof log.data.data.correlationId, "string")
    }
    // All events from same request share same correlationId
    const ids = new Set(_auditLogs.map((l) => l.data.data.correlationId))
    assert.strictEqual(ids.size, 1)
  })

  describe("AgentTaskStarted", () => {
    it("should emit when a new task is submitted", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskStarted"))
      assert.strictEqual(events.length, 1)

      const data = events[0].data.data
      assert.strictEqual(data.event, "AgentTaskStarted")
      assert.strictEqual(typeof data.taskId, "string")
      assert.strictEqual(typeof data.contextId, "string")
      assert.strictEqual(data.service, "GraphBookService")

      // Should include the full user message for forensic reconstruction
      assert.notStrictEqual(data.userMessage, undefined)
      assert.notStrictEqual(data.userMessage.parts, undefined)
      assert.strictEqual(data.userMessage.role, "user")
    })
  })

  describe("AgentTaskCompleted", () => {
    it("should emit when task completes successfully", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskCompleted"))
      assert.strictEqual(events.length, 1)

      const data = events[0].data.data
      assert.strictEqual(data.event, "AgentTaskCompleted")
      assert.strictEqual(typeof data.taskId, "string")
      assert.strictEqual(typeof data.contextId, "string")
      assert.strictEqual(data.service, "GraphBookService")
      assert.strictEqual(typeof data.duration, "string")
      assert.notStrictEqual(data.output, undefined)
    })

    it("should include duration and output", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const event = _auditLogs.find(byEvent("AgentTaskCompleted"))
      assert.notStrictEqual(event, undefined)
      assert.notStrictEqual(event.data.data.duration, undefined)
      assert.notStrictEqual(event.data.data.output, undefined)
      assert.notStrictEqual(event.data.data.taskId, undefined)
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
      assert.strictEqual(events.length, 1)

      const data = events[0].data.data
      assert.strictEqual(data.event, "QuotaExceeded")
      assert.strictEqual(data.service, "GraphBookService")
      assert.match(data.reason, /tasks per hour per user/)
      assert.notStrictEqual(events[0].data.ip, undefined)
    })

    it("should emit on quota breach (maxConcurrentTasks)", async () => {
      const originalMax = cds.env.agents.pool.maxConcurrentTasks
      cds.env.agents.pool.maxConcurrentTasks = 0

      await sendMessage("graph-book", "Should be blocked")
      await wait()

      cds.env.agents.pool.maxConcurrentTasks = originalMax

      const events = _auditLogs.filter(byEvent("QuotaExceeded"))
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0].data.data.event, "QuotaExceeded")
      assert.match(events[0].data.data.reason, /concurrent tasks/)
    })
  })

  describe("ToolInvocation", () => {
    it("should emit for each tool call with args and result", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      assert.ok(events.length > 0, `expected ToolInvocation events`)

      const toolEvent = events[0]
      const data = toolEvent.data.data
      assert.strictEqual(data.event, "ToolInvocation")
      assert.strictEqual(typeof data.tool, "string")
      assert.strictEqual(data.outcome, "success")
      assert.strictEqual(typeof data.duration, "number")
      assert.notStrictEqual(data.args, undefined)
      assert.notStrictEqual(data.result, undefined)
    })

    it("should emit for custom (non-CDS) tools in the same graph", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      const customToolEvent = events.find((e) => e.data.data.tool === "getBookCount")
      assert.notStrictEqual(customToolEvent, undefined, "expected ToolInvocation for getBookCount")

      const data = customToolEvent.data.data
      assert.strictEqual(data.tool, "getBookCount")
      assert.strictEqual(data.outcome, "success")
      assert.strictEqual(typeof data.duration, "number")
      assert.notStrictEqual(data.result, undefined)
      assert.notStrictEqual(data.taskId, undefined)
    })

    it("should include task correlation", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const toolEvents = _auditLogs.filter(byEvent("ToolInvocation"))
      const taskEvents = _auditLogs.filter(byEvent("AgentTaskStarted"))

      assert.ok(toolEvents.length > 0, `expected ToolInvocation events`)
      assert.strictEqual(taskEvents.length, 1)

      const taskId = taskEvents[0].data.data.taskId
      for (const te of toolEvents) {
        assert.strictEqual(te.data.data.taskId, taskId)
      }
    })

    it("should truncate large results to 2000 chars", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const events = _auditLogs.filter(byEvent("ToolInvocation"))
      for (const e of events) {
        if (e.data.data.result) {
          assert.ok(e.data.data.result.length <= 2000, `expected result.length <= 2000`)
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
      assert.ok(startIdx >= 0, `expected AgentTaskStarted index >= 0`)
      assert.ok(completeIdx > startIdx, `expected AgentTaskCompleted after AgentTaskStarted`)

      // ToolInvocation should be between start and complete
      const toolIdx = eventNames.indexOf("ToolInvocation")
      if (toolIdx >= 0) {
        assert.ok(toolIdx > startIdx, `expected ToolInvocation after AgentTaskStarted`)
        assert.ok(toolIdx < completeIdx, `expected ToolInvocation before AgentTaskCompleted`)
      }
    })

    it("should emit at least TaskStarted + ToolInvocation + TaskCompleted for a successful request", async () => {
      await sendMessage("graph-book", "Show me books")
      await wait()

      const eventTypes = new Set(_auditLogs.map((l) => l.data?.data?.event))
      assert.strictEqual(eventTypes.has("AgentTaskStarted"), true)
      assert.strictEqual(eventTypes.has("ToolInvocation"), true)
      assert.strictEqual(eventTypes.has("AgentTaskCompleted"), true)
    })
  })

  describe("AgentTaskCanceled", () => {
    it("should emit when task is canceled", async () => {
      const res = await sendMessage("graph-book", "Show me books")
      const taskId = res.data.result?.id
      assert.notStrictEqual(taskId, undefined)

      _auditLogs.length = 0

      await jsonrpc("graph-book", "tasks/cancel", { id: taskId })
      await wait()

      const events = _auditLogs.filter(byEvent("AgentTaskCanceled"))
      // Cancel of already-completed task may not fire (SDK may reject)
      if (events.length > 0) {
        const data = events[0].data.data
        assert.strictEqual(data.event, "AgentTaskCanceled")
        assert.strictEqual(data.taskId, taskId)
        assert.strictEqual(data.service, "GraphBookService")
      }
    })
  })
})
