import cds from "@sap/cds"
import { ms4 } from "../../utils/utils.js"

const LOG = cds.log("agent")

const TASKS = "cap.agent.Tasks"

// Throttle: last cleanup timestamp per tenant & service
const lastDeletionTriggerMap = new Map()

/** Test-only: reset throttle map. */
export function _resetCleanupThrottle() {
  lastDeletionTriggerMap.clear()
}

// TTL from cds.env.agents.ttl., `false`/0 → disabled.
function resolveTtlMs() {
  const cfg = cds.env.agents?.ttl
  if (cfg === false || cfg === 0) return 0
  const value = cfg === true || cfg
  if (typeof value === "number") return value
  return ms4(String(value))
}

const MS_OF_A_DAY = ms4("1d")

export async function triggerCleanup(serviceName) {
  const ttlMs = resolveTtlMs()
  if (!ttlMs) {
    LOG.debug(`cds.agents.ttl is not configured. Skipping cleanup of old Tasks.`)
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
  serviceMap.set(serviceName, Date.now())
  const delay = ttlMs + MS_OF_A_DAY
  await srv.schedule("cleanupTasks", {}).after(delay)
}

/**
 * GC of expired tasks per service.
 * Compositions cascade automatically: inputFiles, outputFiles, pushConfigs,
 * checkpoints, checkpointWrites.
 */
export async function cleanupExpiredTasks(serviceName) {
  const ttlMs = resolveTtlMs()
  if (!ttlMs) {
    LOG.debug(`cds.agents.ttl is not configured. Skipping cleanup of old Tasks.`)
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
