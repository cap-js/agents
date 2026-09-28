import cds from "@sap/cds"
import { audit } from "../utils/utils.js"
import { AIMessage } from "langchain"
import { CONCURRENT_TASKS_HITL_METADATA_KEY } from "../../srv/handlers/graph-executor/hitl.js"

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
export async function quotaEnforcerAtStart() {
  const quotas = cds.env.agents?.quotas
  if (!quotas) {
    LOG.debug("No quota configuration found at cds.env.agents.quotas — quota enforcement disabled")
    return
  }

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
      .where({
        createdAt: { ">=": lastHour.toISOString() },
        taskId: { "!=": cds.context?.["agent.task.id"] },
      }),
    SELECT.one
      .from(tasks())
      .columns("coalesce(sum(usageLlmTokens),0) as llmTokensThisDay")
      .where({
        createdAt: { ">=": today.toISOString() },
        taskId: { "!=": cds.context?.["agent.task.id"] },
      }),
  ])
  let reason
  let retryAfter
  let hitl = false
  if (quotas.maxConcurrentTasks != null && concurrentTasks >= quotas.maxConcurrentTasks) {
    reason = cds.i18n.messages.at("QUOTA_CONCURRENT_TASKS", [quotas.maxConcurrentTasks])
    retryAfter = 30
  }
  // Only set if HITL got triggered
  if (cds.context["agent.request.metadata"][CONCURRENT_TASKS_HITL_METADATA_KEY]) {
    await cancelActiveTasksForUser(
      cds.context["agent.request.metadata"][CONCURRENT_TASKS_HITL_METADATA_KEY].activeTasks,
    )
    delete cds.context["agent.request.metadata"][CONCURRENT_TASKS_HITL_METADATA_KEY]
  } else if (
    quotas.maxConcurrentTasksPerUser != null &&
    concurrentTasksThisUser >= quotas.maxConcurrentTasksPerUser
  ) {
    reason = cds.i18n.messages.at("QUOTA_CONCURRENT_TASKS_PER_USER", [
      quotas.maxConcurrentTasksPerUser,
    ])
    retryAfter = 30
    hitl = true
  }
  if (quotas.maxTasksPerHour != null && lastHourTasks >= quotas.maxTasksPerHour) {
    reason = cds.i18n.messages.at("QUOTA_TASKS_PER_HOUR", [quotas.maxTasksPerHour])
    retryAfter = secondsUntilNextHour()
  }
  if (
    quotas.maxTasksPerHourPerUser != null &&
    lastHourTasksThisUser >= quotas.maxTasksPerHourPerUser
  ) {
    reason = cds.i18n.messages.at("QUOTA_TASKS_PER_HOUR_PER_USER", [quotas.maxTasksPerHourPerUser])
    retryAfter = secondsUntilNextHour()
  }
  if (quotas.maxToolCallsPerHour != null && lastHourToolCalls >= quotas.maxToolCallsPerHour) {
    reason = cds.i18n.messages.at("QUOTA_TOOL_CALLS_PER_HOUR", [quotas.maxToolCallsPerHour])
    retryAfter = secondsUntilNextHour()
  }
  if (quotas.maxLLMTokensPerDay != null && llmTokensThisDay >= quotas.maxLLMTokensPerDay) {
    reason = cds.i18n.messages.at("QUOTA_LLM_TOKENS_PER_DAY", [quotas.maxLLMTokensPerDay])
    retryAfter = secondsUntilMidnightUTC()
  }

  if (reason) {
    audit("QuotaExceeded", {
      data: {
        service: cds.context?.["agent.service"],
        user: cds.context?.user?.id,
        reason,
        forwardedIp: cds.context.http.req.headers?.["x-forwarded-for"],
      },
      ip: cds.context.http.req.ip,
    })
    const err = new Error(reason)
    err.quotaExceeded = true
    err.retryAfter = retryAfter
    err.hitl = hitl
    throw err
  }
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

export async function quotaEnforcerAtNode(state) {
  const quotas = cds.env.agents?.quotas || {}
  const taskId = cds.context?.["agent.task.id"]

  // In case task got canceled by a HITL quota gate
  if (await isTaskCanceled(taskId)) {
    const err = new Error("Task canceled")
    err.quotaExceeded = true
    throw err
  }

  let reason

  // LLM invocations
  const newCallCount = state.runModelCallCount + 1
  if (quotas.maxLLMInvocationsPerTask && newCallCount > quotas.maxLLMInvocationsPerTask) {
    reason = `LLM call limit exceeded: ${newCallCount} calls (max ${quotas.maxLLMInvocationsPerTask} per task)`
  }

  // Accumulate token usage
  const lastAI = [...state.messages].reverse().find(AIMessage.isInstance)
  const usage = lastAI?.usage_metadata
  const consumed = (usage?.input_tokens || 0) + (usage?.output_tokens || 0)
  const newTokenCount = state.runTokenCount + consumed
  if (quotas.maxLLMTokensPerTask && newTokenCount > quotas.maxLLMTokensPerTask) {
    reason = `Token limit exceeded: ${newTokenCount} tokens (max ${quotas.maxLLMTokensPerTask} per task)`
  }

  // Tool count
  const toolCalls = lastAI?.tool_calls?.length || 0
  const newToolCallCount = state.runToolCallCount + toolCalls
  if (quotas.maxToolCallsPerTask && newToolCallCount > quotas.maxToolCallsPerTask) {
    reason = `Tool call limit exceeded: ${newToolCallCount} calls (max ${quotas.maxToolCallsPerTask} per task)`
  }

  if (reason) {
    audit("QuotaExceeded", {
      data: {
        service: cds.context?.["agent.service"],
        user: cds.context?.user?.id,
        reason,
        taskId: cds.context?.["agent.task.id"],
      },
    })
    const err = new Error(reason)
    err.quotaExceeded = true
    throw err
  }

  return {
    runModelCallCount: newCallCount,
    runTokenCount: newTokenCount,
    runToolCallCount: newToolCallCount,
  }
}

export const ACTIVE_TASK_STATES = ["submitted", "working", "input-required"]

async function cancelActiveTasksForUser(activeTasks) {
  // CDS spawn for different transaction
  cds.spawn({}, async () => {
    const rows = await UPDATE("cap.agent.Tasks")
      .where({
        taskId: { in: activeTasks.map((a) => a.taskId) },
        state: { in: ACTIVE_TASK_STATES },
      })
      .set({ state: "canceled" })
    LOG.info(
      `Canceled ${rows.affected ?? rows} tasks (${activeTasks.map((a) => a.taskId).join(", ")}) to continue with task ${cds.context["agent.task.id"]}`,
    )
  })
}

async function isTaskCanceled(taskId) {
  if (!taskId) return false
  const row = await SELECT.one.from("cap.agent.Tasks").columns("state").where({ taskId })
  return row?.state === "canceled"
}
