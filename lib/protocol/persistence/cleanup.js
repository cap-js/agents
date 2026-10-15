import cds from "@sap/cds"
import { ms4 } from "../../utils/utils.js"
import { createTenantServiceThrottle } from "../../utils/tenant-service-throttle.js"

const LOG = cds.log("agent")

const TASKS = "cap.agent.Tasks"

export const deletionThrottle = createTenantServiceThrottle(ms4("1d"))

// TTL from cds.env.agents.retention., `false`/0 → disabled.
function resolveTtlMs() {
  const cfg = cds.env.agents?.retention
  if (cfg === false || cfg === 0) return 0
  const value = cfg === true || cfg
  if (typeof value === "number") return value
  return ms4(String(value))
}

const MS_OF_A_DAY = ms4("1d")

export async function triggerCleanup(serviceName) {
  const ttlMs = resolveTtlMs()
  if (!ttlMs) {
    LOG.debug(`cds.agents.retention is not configured. Skipping cleanup of old Tasks.`)
    return
  }
  const tenant = cds.context?.tenant
  if (!deletionThrottle.shouldTrigger(tenant, serviceName)) {
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
  deletionThrottle.markTriggered(tenant, serviceName)
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
