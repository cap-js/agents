import cds from "@sap/cds"

cds.test(import.meta.dirname + "/../projects/bookshop")

import {
  triggerCleanup,
  cleanupExpiredTasks,
  _resetCleanupThrottle,
} from "../../lib/protocol/persistence/cleanup.js"

const SERVICE_NAME = "GraphBookService"

function pastDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString()
}

async function insertTask({ taskId, agentService = SERVICE_NAME, modifiedAt }) {
  const { Messages } = cds.entities("cap.agent")
  await INSERT.into(Messages).entries({
    ID: taskId,
    session: taskId,
    role: "user",
    type: "text",
    agentService,
    modifiedAt,
    createdAt: modifiedAt,
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
      const { Messages } = cds.entities("cap.agent")
      cds.env.agents.retention = "7d"

      const oldTaskId = cds.utils.uuid()
      const recentTaskId = cds.utils.uuid()

      await insertTask({ taskId: oldTaskId, modifiedAt: pastDate(10) })
      await insertTask({ taskId: recentTaskId, modifiedAt: pastDate(3) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const old = await SELECT.one.from(Messages).where({ ID: oldTaskId })
      const recent = await SELECT.one.from(Messages).where({ ID: recentTaskId })

      expect(old).toBeUndefined()
      expect(recent).toBeDefined()
    })

    it("should not delete tasks from other services", async () => {
      const { Messages } = cds.entities("cap.agent")
      cds.env.agents.retention = "7d"

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, agentService: "CatalogService", modifiedAt: pastDate(10) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(Messages).where({ ID: taskId })
      expect(row).toBeDefined()
    })

    it("should delete all rows in an expired session", async () => {
      const { Messages } = cds.entities("cap.agent")
      cds.env.agents.retention = "7d"

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(10) })
      await INSERT.into(Messages).entries({
        ID: cds.utils.uuid(),
        session: taskId,
        sequence: 1,
        role: "ai",
        type: "text",
        content: '"done"',
        agentService: SERVICE_NAME,
        modifiedAt: pastDate(10),
        createdAt: pastDate(10),
      })

      await cleanupExpiredTasks(SERVICE_NAME)

      expect(await SELECT.from(Messages).where({ session: taskId })).toHaveLength(0)
    })

    it("should do nothing when retention is disabled (false)", async () => {
      const { Messages } = cds.entities("cap.agent")
      cds.env.agents.retention = false

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(100) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(Messages).where({ ID: taskId })
      expect(row).toBeDefined()
    })

    it("should do nothing when retention is 0", async () => {
      const { Messages } = cds.entities("cap.agent")
      cds.env.agents.retention = 0

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(100) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(Messages).where({ ID: taskId })
      expect(row).toBeDefined()
    })

    it("should accept numeric TTL in milliseconds", async () => {
      const { Messages } = cds.entities("cap.agent")
      cds.env.agents.retention = 5 * 86_400_000 // 5 days

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(6) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(Messages).where({ ID: taskId })
      expect(row).toBeUndefined()
    })
  })

  if (parseInt(cds.version) > 9) {
    describe("triggerCleanup (throttle)", () => {
      beforeEach(async () => {
        const { Messages: OutboxMessages } = cds.entities("cds.outbox")
        await DELETE.from(OutboxMessages).where`msg like '%cleanupTasks%'`
      })

      it("should schedule a cleanupTasks message in the outbox", async () => {
        const { Messages: OutboxMessages } = cds.entities("cds.outbox")
        cds.env.agents.retention = "7d"

        await triggerCleanup(SERVICE_NAME)

        const msgs = await SELECT.from(OutboxMessages).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(1)
        expect(msgs[0].msg).toContain("cleanupTasks")
      })

      it("should not schedule twice within 24h for same service", async () => {
        const { Messages: OutboxMessages } = cds.entities("cds.outbox")
        cds.env.agents.retention = "7d"

        await triggerCleanup(SERVICE_NAME)
        await triggerCleanup(SERVICE_NAME)

        const msgs = await SELECT.from(OutboxMessages).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(1)
      })

      it("should not schedule when retention is disabled", async () => {
        const { Messages: OutboxMessages } = cds.entities("cds.outbox")
        cds.env.agents.retention = false

        await triggerCleanup(SERVICE_NAME)
        const msgs = await SELECT.from(OutboxMessages).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(0)
      })

      it("should not schedule again when outbox already has a cleanupTasks job in the next 24h cleanup window", async () => {
        const { Messages: OutboxMessages } = cds.entities("cds.outbox")
        cds.env.agents.retention = "7d"

        await triggerCleanup(SERVICE_NAME)

        // Simulate server restart: in-memory throttle is empty but outbox task remains.
        _resetCleanupThrottle()

        await triggerCleanup(SERVICE_NAME)

        const msgs = await SELECT.from(OutboxMessages).where(`msg like '%cleanupTasks%'`)
        expect(msgs.length).toBe(1)
      })
    })
  }
})
