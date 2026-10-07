import cds from "@sap/cds"

const LOG = cds.log("agents")

const tasks = () => cds.model.definitions["cap.agent.Messages"]

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
  const lastHour = new Date(Date.now() - 60 * 60 * 1000)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const userId = cds.context?.user?.id

  const rows = await SELECT.from(tasks())
    .columns(
      "ID",
      "session",
      "sequence",
      "role",
      "type",
      "prev_ID",
      "createdAt",
      "createdBy",
      "usageLlmTokens",
      "usageToolCalls",
    )
    .where({ createdAt: { ">=": today.toISOString() } })
  const bySession = Map.groupBy(rows, ({ session, createdBy }) => `${createdBy}\0${session}`)
  const anchors = []
  const active = []
  for (const sessionRows of bySession.values()) {
    sessionRows.sort((left, right) => Number(left.sequence) - Number(right.sequence))
    const indexes = sessionRows
      .map((row, index) => (row.role === "human" && !row.prev_ID ? index : -1))
      .filter((index) => index >= 0)
    indexes.forEach((start, position) => {
      const anchor = sessionRows[start]
      anchors.push(anchor)
      const turn = sessionRows.slice(start + 1, indexes[position + 1] ?? sessionRows.length)
      const terminal = turn.some(
        ({ role, type }) =>
          (role === "assistant" &&
            ["failed", "canceled", "rejected", "auth-required"].includes(type)) ||
          (role === "ai" && type === "text"),
      )
      if (!terminal) active.push(anchor)
    })
  }
  const hourly = anchors.filter(({ createdAt }) => createdAt >= lastHour.toISOString())
  const concurrentTasks = active.length
  const lastHourTasks = hourly.length
  const concurrentTasksThisUser = active.filter(({ createdBy }) => createdBy === userId).length
  const lastHourTasksThisUser = hourly.filter(({ createdBy }) => createdBy === userId).length
  const lastHourToolCalls = hourly.reduce(
    (sum, { usageToolCalls }) => sum + Number(usageToolCalls ?? 0),
    0,
  )
  const llmTokensThisDay = anchors.reduce(
    (sum, { usageLlmTokens }) => sum + Number(usageLlmTokens ?? 0),
    0,
  )
  if (quotas.maxConcurrentTasks != null && concurrentTasks >= quotas.maxConcurrentTasks) {
    return {
      message: cds.i18n.messages.at("QUOTA_CONCURRENT_TASKS", [quotas.maxConcurrentTasks]),
      retryAfter: 30,
    }
  }
  if (
    quotas.maxConcurrentTasksPerUser != null &&
    concurrentTasksThisUser >= quotas.maxConcurrentTasksPerUser
  ) {
    return {
      message: cds.i18n.messages.at("QUOTA_CONCURRENT_TASKS_PER_USER", [
        quotas.maxConcurrentTasksPerUser,
      ]),
      retryAfter: 30,
    }
  }
  if (quotas.maxTasksPerHour != null && lastHourTasks >= quotas.maxTasksPerHour) {
    return {
      message: cds.i18n.messages.at("QUOTA_TASKS_PER_HOUR", [quotas.maxTasksPerHour]),
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (
    quotas.maxTasksPerHourPerUser != null &&
    lastHourTasksThisUser >= quotas.maxTasksPerHourPerUser
  ) {
    return {
      message: cds.i18n.messages.at("QUOTA_TASKS_PER_HOUR_PER_USER", [
        quotas.maxTasksPerHourPerUser,
      ]),
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (quotas.maxToolCallsPerHour != null && lastHourToolCalls >= quotas.maxToolCallsPerHour) {
    return {
      message: cds.i18n.messages.at("QUOTA_TOOL_CALLS_PER_HOUR", [quotas.maxToolCallsPerHour]),
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (quotas.maxLLMTokensPerDay != null && llmTokensThisDay >= quotas.maxLLMTokensPerDay) {
    return {
      message: cds.i18n.messages.at("QUOTA_LLM_TOKENS_PER_DAY", [quotas.maxLLMTokensPerDay]),
      retryAfter: secondsUntilMidnightUTC(),
    }
  }
  return null
}
