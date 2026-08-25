import cds from "@sap/cds"
import { ms4 } from "../../utils/utils.js"

const LOG = cds.log("agent")

const TASKS = "cap.agent.Tasks"
const OUTBOX_MESSAGES = "cds.outbox.Messages"
const DEFAULT_TTL = "30d"

// Throttle: last cleanup timestamp per tenant & service
const lastDeletionTriggerMap = new Map()

/** Test-only: reset throttle map. */
export function _resetCleanupThrottle() {
  lastDeletionTriggerMap.clear()
}

// TTL from cds.env.agents.ttl. `true`/null → 30d, `false`/0 → disabled.
function resolveTtlMs() {
  const cfg = cds.env.agents?.ttl
  if (cfg === false || cfg === 0) return 0
  const value = cfg === true || cfg == null ? DEFAULT_TTL : cfg
  if (typeof value === "number") return value
  try {
    return ms4(String(value))
  } catch {
    LOG.warn("Invalid cds.env.agents.ttl value; using default", { value })
    return ms4(DEFAULT_TTL)
  }
}

const MS_OF_A_DAY = 86_400_000

export async function triggerCleanup(serviceName) {
  const ttlMs = resolveTtlMs()
  if (!ttlMs) {
    LOG.debug(`cds.agents.ttl is not configured. Skipping cleanup of old Tasks.`)
    return
  }
  const tenant = cds.context?.tenant || "_default"
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

  const delay = ttlMs + MS_OF_A_DAY
  if (typeof srv.schedule === "function") {
    // CDS 10+: persistent scheduling via outbox
    await srv.schedule("cleanupTasks", {}).after(delay)
  } else {
    // CDS 9: write directly into outbox — same table, same processing pipeline
    const timestamp = new Date(Date.now() + delay).toISOString()
    const msg = JSON.stringify({
      event: "cleanupTasks",
      data: {},
      _fromSend: true,
      service: serviceName,
      context: { tenant: cds.context?.tenant },
    })
    await UPSERT.into(OUTBOX_MESSAGES).entries({
      ID: cds.utils.uuid(),
      target: "queue",
      timestamp,
      task: "cleanupTasks",
      msg,
    })
  }

  serviceMap.set(serviceName, Date.now())
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

  const tenant = cds.context?.tenant || "_default"
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
