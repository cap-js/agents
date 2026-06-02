import cds from "@sap/cds"
import * as metrics from "./metrics.js"

const LOG = cds.log("a2a")
const TASKS = "cap.a2a.Tasks"

/** Parse interval string (e.g. "24h", "30m", "60s") to milliseconds */
export function parseInterval(val) {
  if (typeof val === "number") return val
  const match = String(val).match(/^(\d+)\s*(ms|s|m|h|d)?$/)
  if (!match) return 24 * 60 * 60 * 1000 // default 24h
  const num = parseInt(match[1], 10)
  const unit = match[2] || "ms"
  const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return num * (multipliers[unit] || 1)
}

/** Cached active users data — updated by computeActiveUsers(), reported by gauge callback */
let _activeUsersData = []

/**
 * Compute active users from Tasks table (last 24h rolling window).
 * Groups by agentService, counts distinct createdBy.
 *
 * In multi-tenant deployments, iterates all subscribed tenants via
 * cds.xt.DeploymentService and queries each tenant's HDI container separately.
 * In single-tenant mode, queries the current DB directly.
 */
export async function computeActiveUsers() {
  _activeUsersData = []

  let tenants
  try {
    const ds = await cds.connect.to("cds.xt.DeploymentService")
    tenants = await ds.getTenants()
  } catch {
    // Not multi-tenant (dev/SQLite) — run in current context
    tenants = null
  }

  if (!tenants) {
    await _computeForTenant(cds.context?.tenant || "anonymous")
  } else {
    for (const tenant of tenants) {
      // eslint-disable-next-line no-await-in-loop
      await cds.spawn({ tenant, user: cds.User.privileged }, () => _computeForTenant(tenant))
    }
  }

  LOG.debug("active_users computed", {
    tenants: tenants?.length || 1,
    services: _activeUsersData.length,
  })
}

async function _computeForTenant(tenant) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const results = await SELECT.from(TASKS)
    .columns("agentService", "count(distinct createdBy) as userCount")
    .where({ createdAt: { ">=": since } })
    .groupBy("agentService")

  for (const r of results) {
    _activeUsersData.push({
      agentService: r.agentService,
      userCount: r.userCount,
      tenant,
    })
  }
}

/** ObservableGauge callback — reports cached values on each OTel collection */
export function observeActiveUsers(result) {
  for (const { agentService, userCount, tenant } of _activeUsersData) {
    result.observe(userCount, {
      "sap.tenantId": tenant,
      "a2a.service": agentService,
    })
  }
}

/**
 * Setup the active_users ObservableGauge + schedule periodic computation.
 * When cds.env.a2a.activeUsersInterval is 0, only the gauge is registered (no automatic scheduling).
 * Apps can still trigger computation manually via executor.emit("computeActiveUsers").
 */
export function setupActiveUsersMetric() {
  const interval = cds.env.a2a?.activeUsersInterval

  // Always register the gauge
  metrics.createActiveUsersGauge(observeActiveUsers)

  // Disabled scheduling when interval is 0 or "0"
  if (interval === 0 || interval === "0") {
    LOG.debug("active_users automatic scheduling disabled (activeUsersInterval = 0)")
    return
  }

  // Schedule periodic computation
  const every = interval || "24h"
  const ms = parseInterval(every)
  const spawned = cds.spawn({ every: ms }, async () => {
    try {
      await computeActiveUsers()
    } catch (err) {
      LOG.error("active_users computation failed", { error: err.message })
    }
  })

  // Clean up timer on shutdown to prevent post-teardown errors in test environments
  if (spawned?.timer) {
    cds.on("shutdown", () => clearInterval(spawned.timer))
  }

  LOG.debug("active_users metric scheduled", { every })
}
