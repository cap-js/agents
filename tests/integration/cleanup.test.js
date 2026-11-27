import cds from "@sap/cds"

cds.test(import.meta.dirname + "/../projects/bookshop")

import {
  triggerCleanup,
  cleanupExpiredTasks,
  _resetCleanupThrottle,
} from "../../lib/protocol/persistence/cleanup.js"

const TASKS = "cap.agent.Tasks"
const SESSIONS = "cap.agent.Sessions"
const MESSAGES = "cap.agent.Messages"
const OUTBOX_MESSAGES = "cds.outbox.Messages"

const SERVICE_NAME = "GraphBookService"

function pastDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString()
}

async function insertTask({
  taskId,
  contextId = cds.utils.uuid(),
  agentService = SERVICE_NAME,
  modifiedAt,
}) {
  await INSERT.into(TASKS).entries({
    taskId,
    contextId,
    state: "completed",
    data: "{}",
    agentService,
    modifiedAt,
    createdAt: modifiedAt,
  })
}

async function insertSession(contextId, modifiedAt = pastDate(10)) {
  const owner = cds.context?.user?.id ?? "anonymous"
  await INSERT.into(SESSIONS).entries({ ID: contextId, owner, createdAt: modifiedAt, modifiedAt })
  await INSERT.into(MESSAGES).entries({
    ID: cds.utils.uuid(),
    session: contextId,
    sequence: 1,
    role: "system",
    type: "data",
    content: "state",
    createdBy: owner,
    createdAt: modifiedAt,
    modifiedAt,
  })
}

describe("@cap-js/agents - Task Cleanup", () => {
  let originalTtl

  before(() => {
    originalTtl = cds.env.agents?.retention
  })

  beforeEach(async () => {
    _resetCleanupThrottle()
  })

  afterEach(() => {
    cds.env.agents.retention = originalTtl
  })

  describe("cleanupExpiredTasks", () => {
    it("should delete tasks older than TTL", async () => {
      cds.env.agents.retention = "7d"

      const oldTaskId = cds.utils.uuid()
      const recentTaskId = cds.utils.uuid()

      await insertTask({ taskId: oldTaskId, modifiedAt: pastDate(10) })
      await insertTask({ taskId: recentTaskId, modifiedAt: pastDate(3) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const old = await SELECT.one.from(TASKS).where({ taskId: oldTaskId })
      const recent = await SELECT.one.from(TASKS).where({ taskId: recentTaskId })

      expect(old).toBeUndefined()
      expect(recent).toBeDefined()
    })

    it("should not delete tasks from other services", async () => {
      cds.env.agents.retention = "7d"

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, agentService: "CatalogService", modifiedAt: pastDate(10) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeDefined()
    })

    it("deletes an expired session and its messages after its last task expires", async () => {
      cds.env.agents.retention = "7d"
      const contextId = cds.utils.uuid()
      await insertTask({ taskId: cds.utils.uuid(), contextId, modifiedAt: pastDate(10) })
      await insertSession(contextId)
      await cleanupExpiredTasks(SERVICE_NAME)
      expect(await SELECT.from(SESSIONS).where({ ID: contextId })).toHaveLength(0)
      expect(await SELECT.from(MESSAGES).where({ session: contextId })).toHaveLength(0)
    })

    it("keeps the complete session while another service still has a task in it", async () => {
      cds.env.agents.retention = "7d"
      const contextId = cds.utils.uuid()
      await insertTask({ taskId: cds.utils.uuid(), contextId, modifiedAt: pastDate(10) })
      await insertTask({
        taskId: cds.utils.uuid(),
        contextId,
        agentService: "OtherService",
        modifiedAt: pastDate(1),
      })
      await insertSession(contextId)
      await cleanupExpiredTasks(SERVICE_NAME)
      expect(await SELECT.from(SESSIONS).where({ ID: contextId })).toHaveLength(1)
      expect(await SELECT.from(MESSAGES).where({ session: contextId })).toHaveLength(1)
    })

    it("keeps a recent session and collects it later after its last task has expired", async () => {
      cds.env.agents.retention = "7d"
      const contextId = cds.utils.uuid()
      await insertTask({ taskId: cds.utils.uuid(), contextId, modifiedAt: pastDate(10) })
      await insertSession(contextId, pastDate(1))
      await cleanupExpiredTasks(SERVICE_NAME)
      expect(await SELECT.from(MESSAGES).where({ session: contextId })).toHaveLength(1)
      await UPDATE(SESSIONS)
        .set({ modifiedAt: pastDate(10) })
        .where({ ID: contextId })
      await cleanupExpiredTasks(SERVICE_NAME)
      expect(await SELECT.from(MESSAGES).where({ session: contextId })).toHaveLength(0)
    })

    it("should do nothing when retention is disabled (false)", async () => {
      cds.env.agents.retention = false

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(100) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeDefined()
    })

    it("should do nothing when retention is 0", async () => {
      cds.env.agents.retention = 0

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(100) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeDefined()
    })

    it("should accept numeric TTL in milliseconds", async () => {
      cds.env.agents.retention = 5 * 86_400_000 // 5 days

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(6) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeUndefined()
    })
  })

  if (parseInt(cds.version) > 9) {
    describe("triggerCleanup (throttle)", () => {
      beforeEach(async () => {
        await DELETE.from(OUTBOX_MESSAGES).where`msg like '%cleanupTasks%'`
      })

      it("should schedule a cleanupTasks message in the outbox", async () => {
        cds.env.agents.retention = "7d"

        await triggerCleanup(SERVICE_NAME)

        const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(1)
        expect(msgs[0].msg).toContain("cleanupTasks")
      })

      it("should not schedule twice within 24h for same service", async () => {
        cds.env.agents.retention = "7d"

        await triggerCleanup(SERVICE_NAME)
        await triggerCleanup(SERVICE_NAME)

        const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(1)
      })

      it("should not schedule when retention is disabled", async () => {
        cds.env.agents.retention = false

        await triggerCleanup(SERVICE_NAME)
        const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(0)
      })

      it("should not schedule again when outbox already has a cleanupTasks job in the next 24h cleanup window", async () => {
        cds.env.agents.retention = "7d"

        await triggerCleanup(SERVICE_NAME)

        // Simulate server restart: in-memory throttle is empty but outbox task remains.
        _resetCleanupThrottle()

        await triggerCleanup(SERVICE_NAME)

        const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(1)
      })
    })
  }
})
