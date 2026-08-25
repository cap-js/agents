import cds from "@sap/cds"

cds.test(import.meta.dirname + "/../projects/bookshop")

import {
  triggerCleanup,
  cleanupExpiredTasks,
  _resetCleanupThrottle,
} from "../../lib/protocol/persistence/cleanup.js"

const TASKS = "cap.agent.Tasks"
const CHECKPOINTS = "cap.agent.Checkpoints"
const CHECKPOINT_WRITES = "cap.agent.CheckpointWrites"
const OUTBOX_MESSAGES = "cds.outbox.Messages"

const SERVICE_NAME = "GraphBookService"

function pastDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString()
}

async function insertTask({ taskId, agentService = SERVICE_NAME, modifiedAt }) {
  await INSERT.into(TASKS).entries({
    taskId,
    contextId: cds.utils.uuid(),
    state: "completed",
    data: "{}",
    agentService,
    modifiedAt,
    createdAt: modifiedAt,
  })
}

async function insertCheckpoint({ taskId, threadId, checkpointId }) {
  await INSERT.into(CHECKPOINTS).entries({
    thread_id: threadId,
    checkpoint_ns: "",
    checkpoint_id: checkpointId,
    task_id: taskId,
    checkpoint: "{}",
    metadata: "{}",
  })
}

async function insertCheckpointWrite({ taskId, threadId, checkpointId, idx = 0 }) {
  await INSERT.into(CHECKPOINT_WRITES).entries({
    thread_id: threadId,
    checkpoint_ns: "",
    checkpoint_id: checkpointId,
    task_id: taskId,
    idx,
    channel: "__start__",
    value: "{}",
  })
}

describe("@cap-js/agents - Task Cleanup", () => {
  let originalTtl

  before(() => {
    originalTtl = cds.env.agents?.ttl
  })

  beforeEach(async () => {
    _resetCleanupThrottle()
    await DELETE.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
  })

  afterEach(() => {
    cds.env.agents.ttl = originalTtl
  })

  describe("cleanupExpiredTasks", () => {
    it("should delete tasks older than TTL", async () => {
      cds.env.agents.ttl = "7d"

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
      cds.env.agents.ttl = "7d"

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, agentService: "CatalogService", modifiedAt: pastDate(10) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeDefined()
    })

    it("should cascade-delete related checkpoints", async () => {
      cds.env.agents.ttl = "7d"

      const taskId = cds.utils.uuid()
      const threadId = cds.utils.uuid()
      const checkpointId = cds.utils.uuid()

      await insertTask({ taskId, modifiedAt: pastDate(10) })
      await insertCheckpoint({ taskId, threadId, checkpointId })

      await cleanupExpiredTasks(SERVICE_NAME)

      const cp = await SELECT.one.from(CHECKPOINTS).where({ checkpoint_id: checkpointId })
      expect(cp).toBeUndefined()
    })

    it("should cascade-delete related checkpoint writes", async () => {
      cds.env.agents.ttl = "7d"

      const taskId = cds.utils.uuid()
      const threadId = cds.utils.uuid()
      const checkpointId = cds.utils.uuid()

      await insertTask({ taskId, modifiedAt: pastDate(10) })
      await insertCheckpoint({ taskId, threadId, checkpointId })
      await insertCheckpointWrite({ taskId, threadId, checkpointId })

      await cleanupExpiredTasks(SERVICE_NAME)

      const cw = await SELECT.one.from(CHECKPOINT_WRITES).where({ checkpoint_id: checkpointId })
      expect(cw).toBeUndefined()
    })

    it("should do nothing when ttl is disabled (false)", async () => {
      cds.env.agents.ttl = false

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(100) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeDefined()
    })

    it("should do nothing when ttl is 0", async () => {
      cds.env.agents.ttl = 0

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(100) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeDefined()
    })

    it("should use default 30d TTL when ttl is null", async () => {
      cds.env.agents.ttl = null

      const taskId30d = cds.utils.uuid()
      const taskId40d = cds.utils.uuid()

      await insertTask({ taskId: taskId30d, modifiedAt: pastDate(25) })
      await insertTask({ taskId: taskId40d, modifiedAt: pastDate(40) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const recent = await SELECT.one.from(TASKS).where({ taskId: taskId30d })
      const old = await SELECT.one.from(TASKS).where({ taskId: taskId40d })

      expect(recent).toBeDefined()
      expect(old).toBeUndefined()
    })

    it("should accept numeric TTL in milliseconds", async () => {
      cds.env.agents.ttl = 5 * 86_400_000 // 5 days

      const taskId = cds.utils.uuid()
      await insertTask({ taskId, modifiedAt: pastDate(6) })

      await cleanupExpiredTasks(SERVICE_NAME)

      const row = await SELECT.one.from(TASKS).where({ taskId })
      expect(row).toBeUndefined()
    })
  })

  describe("triggerCleanup (throttle)", () => {
    it("should schedule a cleanupTasks message in the outbox", async () => {
      cds.env.agents.ttl = "7d"

      await triggerCleanup(SERVICE_NAME)

      const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
      expect(msgs.length).toBe(1)
      expect(msgs[0].msg).toContain("cleanupTasks")
    })

    it("should not schedule twice within 24h for same service", async () => {
      cds.env.agents.ttl = "7d"

      await triggerCleanup(SERVICE_NAME)
      await triggerCleanup(SERVICE_NAME)

      const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
      expect(msgs.length).toBe(1)
    })

    it("should not schedule when ttl is disabled", async () => {
      cds.env.agents.ttl = false

      await triggerCleanup(SERVICE_NAME)
      const msgs = await SELECT.from(OUTBOX_MESSAGES).where(`msg like '%cleanupTasks%'`)
      expect(msgs.length).toBe(0)
    })
  })
})
