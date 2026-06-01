const cds = require("@sap/cds")
const LOG = cds.log("a2a")
const utils = require("../../../utils")
const { short } = utils

module.exports = async function quotaEnforcerAtNode(state, config) {
  const pool = cds.env.a2a?.pool
  if (!pool) {
    LOG.warn("No quota pool configuration found at cds.env.a2a.pool — quota enforcement disabled")
    return "next"
  }

  const task = short(config?.configurable?._taskId)
  const service = config?.configurable?._service
  const context = {
    task,
    service,
    iterations: state._iterations,
    totalTokens: state._totalTokens,
    totalToolCalls: state._totalToolCalls,
  }

  let reason
  if (pool.maxLLMInvocationsPerTask != null && state._iterations >= pool.maxLLMInvocationsPerTask) {
    reason = `Max iterations reached (${state._iterations}/${pool.maxLLMInvocationsPerTask})`
  } else if (pool.maxLLMTokensPerTask != null && state._totalTokens >= pool.maxLLMTokensPerTask) {
    reason = `Max tokens per task reached (${state._totalTokens}/${pool.maxLLMTokensPerTask})`
  } else if (
    pool.maxToolCallsPerTask != null &&
    state._totalToolCalls >= pool.maxToolCallsPerTask
  ) {
    reason = `Max tool calls per task reached (${state._totalToolCalls}/${pool.maxToolCallsPerTask})`
  }

  if (reason) {
    LOG.warn(reason, context)
    utils.audit("QuotaExceeded", {
      data: {
        service,
        taskId: config?.configurable?._taskId,
        user: cds.context?.user?.id,
        reason,
      },
    })
    return "end"
  }
  return "next"
}
