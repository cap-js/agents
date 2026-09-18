import cds from "@sap/cds"
import { ms4 } from "../../utils/utils.js"

const LOG = cds.log("agent")

const TASKS = "cap.agent.Tasks"
const OUTBOX_MESSAGES = "cds.outbox.Messages"

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
  return ms4(String(value))
}

const MS_OF_A_DAY = ms4("1d")

async function hasScheduledCleanupOnTTLDate(serviceName, ttlMs, now = Date.now()) {
  const fireDayMs = now + ttlMs + MS_OF_A_DAY
  const fireDay = new Date(fireDayMs)
  fireDay.setUTCHours(0, 0, 0, 0)
  const windowStart = fireDay.toISOString()
  const windowEnd = new Date(fireDay.getTime() + MS_OF_A_DAY).toISOString()
  const existingMessage = await SELECT.one.from(OUTBOX_MESSAGES).where`
    msg like ${`%"event":"cleanupTasks"%`} and
    msg like ${`%"service":"${serviceName}"%`} and
    timestamp > ${windowStart} and
    timestamp <= ${windowEnd}
    `
  return !!existingMessage
}

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
  if (await hasScheduledCleanupOnTTLDate(serviceName, ttlMs, now)) {
    serviceMap.set(serviceName, now)
    LOG.debug(
      `Skip scheduling deletion of tasks for ${serviceName} because a cleanupTasks job is already scheduled on the TTL date.`,
    )
    return
  }
  serviceMap.set(serviceName, now)
  const MAX_TIMEOUT = 2_147_483_647
  const delay = Math.min(ttlMs + MS_OF_A_DAY, MAX_TIMEOUT)
  const scheduled = srv.schedule("cleanupTasks", {})
  const taskName = `cleanupTasks-${new Date().toISOString()}-${cds.utils.uuid()}`
  // .as in cds10
  if (typeof scheduled.as === "function") await scheduled.as(taskName).after(delay)
  // .asTask in cds9.9
  else if (typeof scheduled.asTask === "function") await scheduled.asTask(taskName).after(delay)
  // cds9 < 9.9 has no task naming API
  else await scheduled.after(delay)
}

/**
 * GC of expired tasks per service.
 * Compositions cascade automatically: inputFiles, outputFiles, pushConfigs,
 * checkpoints, checkpointWrites.
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

  if (deletedTasks > 0) {
    LOG.debug("Cleanup", { tenant, deletedTasks, cutoff })
  }
}
