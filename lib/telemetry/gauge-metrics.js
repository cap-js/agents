import cds from "@sap/cds"
import * as metrics from "./metrics.js"
import { createTenantServiceThrottle } from "../utils/tenant-service-throttle.js"
import { ms4 } from "../utils/utils.js"

const LOG = cds.log("agents")
const TASKS = "cap.agent.Tasks"
const gaugeCollectionThrottle = createTenantServiceThrottle(ms4("1d"))

/** Cached tenant metrics — updated by computeGaugeMetrics(), reported by gauge callbacks */
const _tenantMetrics = new Map()

export async function computeGaugeMetrics() {
  const tenant = cds.context?.tenant || "anonymous"
  const data = await _computeForTenant(tenant)
  _tenantMetrics.set(tenant, data)

  LOG.debug("gauge metrics computed", {
    tenant,
    services: data.length,
  })
}

export async function triggerGaugeMetrics(serviceName) {
  const tenant = cds.context?.tenant || "anonymous"
  if (!gaugeCollectionThrottle.shouldTrigger(tenant, serviceName)) {
    LOG.debug("Skip gauge metric collection; triggered within the last 24h", {
      tenant,
      serviceName,
    })
    return
  }

  gaugeCollectionThrottle.markTriggered(tenant, serviceName)
  try {
    await computeGaugeMetrics()
  } catch (err) {
    LOG.error("gauge metric computation failed", { error: err.message, tenant, serviceName })
  }
}

async function _computeForTenant(tenant) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [activeUsers, conversations] = await Promise.all([
    SELECT.from(TASKS)
      .columns("agentService", "count(distinct createdBy) as userCount")
      .where({ createdAt: { ">=": since } })
      .groupBy("agentService"),
    SELECT.from(TASKS)
      .columns(
        "agentService",
        "count(distinct contextId) as conversationCount",
        "count(*) * 1.0 / count(distinct contextId) as avgConversationLength",
      )
      .groupBy("agentService"),
  ])

  const activeUserCounts = new Map(activeUsers.map((r) => [r.agentService, r.userCount]))
  return conversations.map((r) => ({
    agentService: r.agentService,
    userCount: activeUserCounts.get(r.agentService) || 0,
    conversationCount: r.conversationCount,
    avgConversationLength: r.avgConversationLength,
    tenant,
  }))
}

export function observeActiveUsers(result) {
  for (const data of _tenantMetrics.values()) {
    for (const { agentService, userCount, tenant } of data) {
      result.observe(userCount, {
        "sap.tenantId": tenant,
        "agent.service": agentService,
      })
    }
  }
}

export function observeConversationCount(result) {
  for (const data of _tenantMetrics.values()) {
    for (const { agentService, conversationCount, tenant } of data) {
      result.observe(conversationCount, {
        "sap.tenantId": tenant,
        "agent.service": agentService,
      })
    }
  }
}

export function observeAverageConversationLength(result) {
  for (const data of _tenantMetrics.values()) {
    for (const { agentService, avgConversationLength, tenant } of data) {
      result.observe(avgConversationLength, {
        "sap.tenantId": tenant,
        "agent.service": agentService,
      })
    }
  }
}

/**
 * Setup ObservableGauges. Computation runs asynchronously after a new A2A task.
 */
export function setupGaugeMetrics() {
  metrics.createActiveUsersGauge(observeActiveUsers)
  metrics.createConversationCountGauge(observeConversationCount)
  metrics.createAverageConversationLengthGauge(observeAverageConversationLength)
}
