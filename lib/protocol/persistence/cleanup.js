import cds from "@sap/cds"
import { CdsMessageStore, sessionId } from "./message-store.js"

const LOG = cds.log("agent")

const TASKS = "cap.agent.Tasks"

// Throttle: last cleanup timestamp per tenant & service
const lastDeletionTriggerMap = new Map()

/** Test-only: reset throttle map. */
export function _resetCleanupThrottle() {
  lastDeletionTriggerMap.clear()
}

// TTL from cds.env.agents.retention., `false`/0 → disabled.
function resolveTtlMs() {
  const cfg = cds.env.agents?.retention
  if (cfg === false || cfg === 0) return 0
  const value = cfg === true || cfg
  if (typeof value === "number") return value
  return cds.utils.ms4(String(value))
}

const MS_OF_A_DAY = cds.utils.ms4("1d")

export async function triggerCleanup(serviceName) {
  const ttlMs = resolveTtlMs()
  if (!ttlMs) {
    LOG.debug(`cds.agents.retention is not configured. Skipping cleanup of old Tasks.`)
    return
  }
  const tenant = cds.context?.tenant
  if (!lastDeletionTriggerMap.has(tenant)) lastDeletionTriggerMap.set(tenant, new Map())
  const serviceMap = lastDeletionTriggerMap.get(tenant)
  const lastDeletionTriggered = serviceMap.get(serviceName)
  if (lastDeletionTriggered > Date.now() - MS_OF_A_DAY) {
    LOG.debug(
      `Skip scheduling deletion of tasks for ${serviceName} because the last scheduled deletion was triggered within the last 24h.`,
    )
    return
  }
  const srv = cds.services[serviceName]
  if (!srv) {
    LOG.warn(`triggerCleanup: service "${serviceName}" not found in cds.services, skipping.`)
    return
  }
  if (typeof srv.schedule !== "function") {
    LOG.debug(`triggerCleanup: srv.schedule not available (CDS < 9). Skipping cleanup scheduling.`)
    return
  }
  const now = Date.now()
  serviceMap.set(serviceName, now)
  const delay = ttlMs + MS_OF_A_DAY
  const scheduled = srv.schedule("cleanupTasks", {})
  const taskName = `cleanupTasks-${srv.name}-${new Date().toDateString().substring(0, 10)}`
  // .as in cds10
  if (typeof scheduled.as === "function") await scheduled.as(taskName).after(delay)
  // .asTask in cds9.9
  else if (typeof scheduled.asTask === "function") await scheduled.asTask(taskName).after(delay)
  // cds9 < 9.9 has no task naming API
  else {
    LOG.error("Cannot schedule cleanup of old tasks. Please update your @sap/cds version.")
  }
}

/**
 * GC of expired tasks per service.
 * Task compositions cascade automatically. Shared conversation state is removed
 * only when the session is also expired and no tasks still reference it.
 */
export async function cleanupExpiredTasks(serviceName) {
  const ttlMs = resolveTtlMs()
  if (!ttlMs) {
    LOG.debug(`cds.agents.retention is not configured. Skipping cleanup of old Tasks.`)
    return
  }

  const tenant = cds.context?.tenant
  const now = Date.now()
  const cutoff = new Date(now - ttlMs).toISOString()
  const taskResult = await DELETE.from(TASKS).where({
    modifiedAt: { "<": cutoff },
    agentService: serviceName,
  })
  // affectedRows since cds10
  const deletedTasks = typeof taskResult === "number" ? taskResult : taskResult?.affectedRows || 0

  // Revisit orphan sessions too: their final task may have expired in an
  // earlier cleanup while the session itself was still recent.
  const sessions = await SELECT.from("cap.agent.Sessions")
    .columns("ID", "owner")
    .where({ modifiedAt: { "<": cutoff } })
  for (const { ID: contextId, owner: createdBy } of sessions) {
    // eslint-disable-next-line no-await-in-loop
    await cds.tx({ user: new cds.User({ id: createdBy }) }, async () => {
      const session = await SELECT.one
        .from("cap.agent.Sessions")
        .where({ ID: sessionId(contextId), owner: createdBy })
        .forUpdate()
      if (!session || session.modifiedAt >= cutoff) return
      const active = await SELECT.one.from(TASKS).columns("taskId").where({ contextId, createdBy })
      if (!active) await new CdsMessageStore().deleteSession(contextId)
    })
  }

  if (deletedTasks > 0) {
    LOG.debug("Cleanup", { tenant, deletedTasks, cutoff })
  }
}
