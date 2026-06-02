import cds from "@sap/cds"
import { short } from "../../../utils.js"

const LOG = cds.log("a2a")

/**
 *
 * @param {import("@sap-ai-sdk/langchain").OrchestrationClient} model
 * @returns
 */
export default (model) =>
  async function agentNode(state, config) {
    const task = short(config?.configurable?._taskId)
    const service = config?.configurable?._service
    const iteration = state._iterations + 1
    const msgCount = state.messages.length

    LOG.debug("LLM request", { task, service, messages: msgCount, iteration })
    LOG.debug("LLM request messages", {
      task,
      service,
      types: state.messages.map((m) => m.constructor.name || m._getType?.()),
    })

    // Pass config to model.invoke so prototype-level audit/tracing patches
    // can access _taskId, _service, and _iteration for correlation.
    const modelConfig = {
      ...config,
      configurable: { ...config?.configurable, _iteration: iteration },
    }

    if (cds.context) cds.context["a2a.iteration"] = iteration

    const t0 = Date.now()
    const response = await model.invoke(state.messages, modelConfig)
    const duration = ((Date.now() - t0) / 1000).toFixed(1) + "s"

    const toolCalls = response.tool_calls || []
    const usage = response.usage_metadata
    const tokens = usage?.total_tokens || usage?.output_tokens || 0

    LOG.debug("LLM response", { task, service, duration, toolCalls: toolCalls.length, tokens })
    if (toolCalls.length > 0) {
      LOG.debug("LLM response tools", { task, service, tools: toolCalls.map((tc) => tc.name) })
    }

    return {
      messages: [response],
      toolCalls,
      output: response.content,
      _iterations: iteration,
      _totalTokens: state._totalTokens + tokens,
    }
  }
