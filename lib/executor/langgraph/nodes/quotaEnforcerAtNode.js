const cds = require("@sap/cds")
const LOG = cds.log("a2a")
const { short } = require("../../../utils")

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

  if (pool.maxLLMInvocationsPerTask != null && state._iterations >= pool.maxLLMInvocationsPerTask) {
    LOG.warn(
      `Max iterations reached (${state._iterations}/${pool.maxLLMInvocationsPerTask})`,
      context,
    )
    return "end"
  }
  if (pool.maxLLMTokensPerTask != null && state._totalTokens >= pool.maxLLMTokensPerTask) {
    LOG.warn(
      `Max tokens per task reached (${state._totalTokens}/${pool.maxLLMTokensPerTask})`,
      context,
    )
    return "end"
  }
  if (pool.maxToolCallsPerTask != null && state._totalToolCalls >= pool.maxToolCallsPerTask) {
    LOG.warn(
      `Max tool calls per task reached (${state._totalToolCalls}/${pool.maxToolCallsPerTask})`,
      context,
    )
    return "end"
  }
  return "next"
}
