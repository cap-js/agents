import cds from "@sap/cds"

const LOG = cds.log("agents")

/**
 * Quota enforcement before graph execution.
 * Returns null if within limits, or { message, retryAfter } if a limit is breached.
 */
export default async function quotaEnforcerAtStart() {
  const quotas = cds.env.agents?.quotas
  if (!quotas) {
    LOG.debug("No quota configuration found at cds.env.agents.quotas — quota enforcement disabled")
    return null
  }

  // REVISIT: If applications ask for it, add agent quota annotations which allow to enforce agent service specific quotas.
  // Keep extensibility in mind that customers then would not be able to override own limits.
  const { QuotaUsage } = cds.entities("cap.agent")
  const usage = await SELECT.one.from(QuotaUsage)

  const exceeded = [
    {
      quota: "maxConcurrentTasks",
      usage: usage.concurrentTasks,
      message: "QUOTA_CONCURRENT_TASKS",
      retryAfter: () => 30,
    },
    {
      quota: "maxConcurrentTasksPerUser",
      usage: usage.concurrentTasksThisUser,
      message: "QUOTA_CONCURRENT_TASKS_PER_USER",
      retryAfter: () => 30,
    },
    {
      quota: "maxTasksPerHour",
      usage: usage.lastHourTasks,
      message: "QUOTA_TASKS_PER_HOUR",
      retryAfter: secondsUntilNextHour,
    },
    {
      quota: "maxTasksPerHourPerUser",
      usage: usage.lastHourTasksThisUser,
      message: "QUOTA_TASKS_PER_HOUR_PER_USER",
      retryAfter: secondsUntilNextHour,
    },
    {
      quota: "maxToolCallsPerHour",
      usage: usage.lastHourToolCalls,
      message: "QUOTA_TOOL_CALLS_PER_HOUR",
      retryAfter: secondsUntilNextHour,
    },
    {
      quota: "maxLLMTokensPerDay",
      usage: usage.llmTokensThisDay,
      message: "QUOTA_LLM_TOKENS_PER_DAY",
      retryAfter: secondsUntilMidnightUTC,
    },
  ].find(({ quota, usage }) => quotas[quota] != null && (usage ?? 0) >= quotas[quota])

  if (!exceeded) return null

  const { quota, message, retryAfter } = exceeded
  return {
    message: cds.i18n.messages.at(message, [quotas[quota]]),
    retryAfter: retryAfter(),
  }
}

function secondsUntilNextHour() {
  const now = new Date()
  const next = new Date(now)
  next.setUTCMinutes(0, 0, 0)
  next.setUTCHours(next.getUTCHours() + 1)
  return Math.ceil((next - now) / 1000)
}

function secondsUntilMidnightUTC() {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setUTCHours(24, 0, 0, 0)
  return Math.ceil((midnight - now) / 1000)
}
