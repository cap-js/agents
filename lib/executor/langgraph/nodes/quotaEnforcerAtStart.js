const cds = require("@sap/cds")
const LOG = cds.log("a2a")

const TASKS = "cap.a2a.Tasks"

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
module.exports = async function quotaEnforcerAtStart() {
  const pool = cds.env.a2a?.pool
  if (!pool) {
    LOG.warn("No quota pool configuration found at cds.env.a2a.pool — quota enforcement disabled")
    return null
  }

  // REVISIT: If applications ask for it, add a2a quota annotations which allow to enforce agent service specific quotas.
  // Keep extensibility in mind that customers then would not be able to override own limits.
  const lastHour = new Date(Date.now() - 60 * 60 * 1000)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

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
      .from(TASKS)
      .columns(
        "coalesce(sum(cast(case when state in ('submitted', 'working', 'input-required') then 1 else 0 end as cds.Integer)),0) as concurrentTasks",
        "count(*) as lastHourTasks",
        concurrentTasksThisUserColFactory(cds.context.user.id),
        lastHourTasksThisUserColFactory(cds.context.user.id),
        "coalesce(sum(usageToolCalls), 0) as lastHourToolCalls",
      )
      .where({ createdAt: { ">=": lastHour.toISOString() } }),
    SELECT.one
      .from(TASKS)
      .columns("coalesce(sum(usageLlmTokens),0) as llmTokensThisDay")
      .where({ createdAt: { ">=": today.toISOString() } }),
  ])
  if (pool.maxConcurrentTasks != null && concurrentTasks >= pool.maxConcurrentTasks) {
    return {
      message: `The maximum of ${pool.maxConcurrentTasks} concurrent tasks is reached. Please try again later.`,
      retryAfter: 30,
    }
  }
  if (
    pool.maxConcurrentTasksPerUser != null &&
    concurrentTasksThisUser >= pool.maxConcurrentTasksPerUser
  ) {
    return {
      message: `The maximum of ${pool.maxConcurrentTasksPerUser} concurrent tasks per user is reached. Please try again later.`,
      retryAfter: 30,
    }
  }
  if (pool.maxTasksPerHour != null && lastHourTasks >= pool.maxTasksPerHour) {
    return {
      message: `The maximum of ${pool.maxTasksPerHour} tasks per hour for this tenant is reached. Please try again later.`,
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (pool.maxTasksPerHourPerUser != null && lastHourTasksThisUser >= pool.maxTasksPerHourPerUser) {
    return {
      message: `The maximum of ${pool.maxTasksPerHourPerUser} tasks per hour per user is reached. Please try again later.`,
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (pool.maxToolCallsPerHour != null && lastHourToolCalls >= pool.maxToolCallsPerHour) {
    return {
      message: `The maximum amount of tool calls per hour was used (${pool.maxToolCallsPerHour}). Please try again later.`,
      retryAfter: secondsUntilNextHour(),
    }
  }
  if (pool.maxLLMTokensPerDay != null && llmTokensThisDay >= pool.maxLLMTokensPerDay) {
    return {
      message: `The maximum amount of LLM tokens for today was already used (${pool.maxLLMTokensPerDay}). Please try again tomorrow.`,
      retryAfter: secondsUntilMidnightUTC(),
    }
  }
  return null
}

const concurrentTasksThisUserColFactory = (userId) => ({
  xpr: [
    {
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
                { val: 1 },
                "else",
                { val: 0 },
                "end",
              ],
              cast: { type: "cds.Integer" },
            },
          ],
        },
        { val: 0 },
      ],
    },
  ],
  as: "concurrentTasksThisUser",
})

const lastHourTasksThisUserColFactory = (userId) => ({
  xpr: [
    {
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
                { val: 1 },
                "else",
                { val: 0 },
                "end",
              ],
              cast: { type: "cds.Integer" },
            },
          ],
        },
        { val: 0 },
      ],
    },
  ],
  as: "lastHourTasksThisUser",
})
