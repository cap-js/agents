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

    it("should cascade-delete related checkpoints", async () => {
      cds.env.agents.retention = "7d"

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
      cds.env.agents.retention = "7d"

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
    })
  }

  describe("cleanupOrphanedPseudonymization", () => {
    const PSEUDO_STATE = "cap.agent.PseudonymizationState"
    const PSEUDO_MAPPINGS = "cap.agent.PseudonymizationMappings"

    async function seedPseudo(threadId) {
      await INSERT.into(PSEUDO_STATE).entries({ threadId, seed: "deadbeef" })
      await INSERT.into(PSEUDO_MAPPINGS).entries({
        threadId,
        hash: "name_abcd1234",
        original: "Emily Brontë",
      })
    }

    afterEach(async () => {
      await DELETE.from(PSEUDO_STATE)
      await DELETE.from(TASKS)
    })

    it("deletes pseudonymization state for a thread with no surviving task", async () => {
      cds.env.agents.retention = "7d"
      const contextId = cds.utils.uuid()
      const threadId = `${SERVICE_NAME}:${contextId}`
      await seedPseudo(threadId)
      // no Task exists for this contextId

      await cleanupExpiredTasks(SERVICE_NAME)

      const state = await SELECT.one.from(PSEUDO_STATE).where({ threadId })
      const mappings = await SELECT.from(PSEUDO_MAPPINGS).where({ threadId })
      expect(state).toBeUndefined()
      expect(mappings.length).toBe(0) // composition cascade
    })

    it("keeps pseudonymization state while a task for the same thread still exists", async () => {
      cds.env.agents.retention = "7d"
      const contextId = cds.utils.uuid()
      const threadId = `${SERVICE_NAME}:${contextId}`
      await seedPseudo(threadId)
      // a recent task keeps the thread alive
      await INSERT.into(TASKS).entries({
        taskId: cds.utils.uuid(),
        contextId,
        state: "completed",
        data: "{}",
        agentService: SERVICE_NAME,
        modifiedAt: pastDate(1),
        createdAt: pastDate(1),
      })

      await cleanupExpiredTasks(SERVICE_NAME)

      const state = await SELECT.one.from(PSEUDO_STATE).where({ threadId })
      expect(state).toBeDefined()
    })

    it("does not delete pseudonymization state of another service", async () => {
      cds.env.agents.retention = "7d"
      const contextId = cds.utils.uuid()
      const threadId = `OtherService:${contextId}`
      await seedPseudo(threadId)

      await cleanupExpiredTasks(SERVICE_NAME)

      const state = await SELECT.one.from(PSEUDO_STATE).where({ threadId })
      expect(state).toBeDefined()
    })
  })
})
