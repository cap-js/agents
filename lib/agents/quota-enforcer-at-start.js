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
  const pool = cds.env.agents?.pool
  if (!pool) {
    LOG.debug(
      "No quota pool configuration found at cds.env.agents.pool — quota enforcement disabled",
    )
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
  if (pool.maxConcurrentTasks != null && concurrentTasks >= pool.maxConcurrentTasks) {
    return {
      message: cds.i18n.messages.at("QUOTA_CONCURRENT_TASKS", [pool.maxConcurrentTasks]),
      retryAfter: 30,
    }
  }
  if (
    pool.maxConcurrentTasksPerUser != null &&
    concurrentTasksThisUser >= pool.maxConcurrentTasksPerUser
  ) {
    return {
      message: cds.i18n.messages.at("QUOTA_CONCURRENT_TASKS_PER_USER", [
        pool.maxConcurrentTasksPerUser,
      ]),
      retryAfter: 30,
    }
  }
  if (pool.maxTasksPerHour != null && lastHourTasks >= pool.maxTasksPerHour) {
    return {
      message: cds.i18n.messages.at("QUOTA_TASKS_PER_HOUR", [pool.maxTasksPerHour]),
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (pool.maxTasksPerHourPerUser != null && lastHourTasksThisUser >= pool.maxTasksPerHourPerUser) {
    return {
      message: cds.i18n.messages.at("QUOTA_TASKS_PER_HOUR_PER_USER", [pool.maxTasksPerHourPerUser]),
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (pool.maxToolCallsPerHour != null && lastHourToolCalls >= pool.maxToolCallsPerHour) {
    return {
      message: cds.i18n.messages.at("QUOTA_TOOL_CALLS_PER_HOUR", [pool.maxToolCallsPerHour]),
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (pool.maxLLMTokensPerDay != null && llmTokensThisDay >= pool.maxLLMTokensPerDay) {
    return {
      message: cds.i18n.messages.at("QUOTA_LLM_TOKENS_PER_DAY", [pool.maxLLMTokensPerDay]),
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
