import cds from "@sap/cds"

const LOG = cds.log("agents")

const tasks = () => cds.model.definitions["cap.agent.Tasks"]

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

  const [
    {
      concurrentTasks,
      lastHourTasks,
      concurrentTasksThisUser,
      lastHourTasksThisUser,
      lastHourToolCalls,
    },
    { llmTokensThisDay },
  ] = await Promise.all([
    SELECT.one
      .from(tasks())
      .columns(
        concurrentTasksCol,
        "count(*) as lastHourTasks",
        concurrentTasksThisUserColFactory(userId),
        lastHourTasksThisUserColFactory(userId),
        "coalesce(sum(usageToolCalls), 0) as lastHourToolCalls",
      )
      .where({ createdAt: { ">=": lastHour.toISOString() } }),
    SELECT.one
      .from(tasks())
      .columns("coalesce(sum(usageLlmTokens),0) as llmTokensThisDay")
      .where({ createdAt: { ">=": today.toISOString() } }),
  ])
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

const concurrentTasksCol = {
  func: "coalesce",
  args: [
    {
      func: "sum",
      args: [
        {
          xpr: [
            "case",
            "when",
            { ref: ["state"] },
            "in",
            { list: [{ val: "submitted" }, { val: "working" }, { val: "input-required" }] },
            "then",
            { val: 1, param: false },
            "else",
            { val: 0, param: false },
            "end",
          ],
          cast: { type: "cds.Integer" },
        },
      ],
    },
    { val: 0 },
  ],
  as: "concurrentTasks",
}

const concurrentTasksThisUserColFactory = (userId) => ({
  func: "coalesce",
  args: [
    {
      func: "sum",
      args: [
        {
          xpr: [
            "case",
            "when",
            { ref: ["createdBy"] },
            "=",
            { val: userId },
            "and",
            { ref: ["state"] },
            "in",
            { list: [{ val: "submitted" }, { val: "working" }, { val: "input-required" }] },
            "then",
            { val: 1, param: false },
            "else",
            { val: 0, param: false },
            "end",
          ],
          cast: { type: "cds.Integer" },
        },
      ],
    },
    { val: 0 },
  ],
  as: "concurrentTasksThisUser",
})

const lastHourTasksThisUserColFactory = (userId) => ({
  func: "coalesce",
  args: [
    {
      func: "sum",
      args: [
        {
          xpr: [
            "case",
            "when",
            { ref: ["createdBy"] },
            "=",
            { val: userId },
            "then",
            { val: 1, param: false },
            "else",
            { val: 0, param: false },
            "end",
          ],
          cast: { type: "cds.Integer" },
        },
      ],
    },
    { val: 0 },
  ],
  as: "lastHourTasksThisUser",
})
