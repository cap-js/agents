const cds = require("@sap/cds")

const LOG = cds.log("a2a")
const MAX_ITERATIONS = 10
const { short } = require("../../utils")

function createNodes(model, toolMap) {
  async function agentNode(state, config) {
    const task = short(config?.configurable?._taskId)
    const service = config?.configurable?._service
    const iteration = state.iterations + 1
    const msgCount = state.messages.length

    LOG.debug("LLM request", { task, service, messages: msgCount, iteration })
    LOG.debug("LLM request messages", {
      task,
      service,
      types: state.messages.map((m) => m.constructor.name || m._getType?.()),
    })

    const t0 = Date.now()
    const response = await model.invoke(state.messages)
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
      iterations: iteration,
      _totalTokens: tokens,
    }
  }

  async function toolNode(state, config) {
    const task = short(config?.configurable?._taskId)
    const service = config?.configurable?._service
    const { ToolMessage } = await import("@langchain/core/messages")
    const results = await Promise.all(
      state.toolCalls.map(async (toolCall) => {
        const { name, args, id } = toolCall
        const tool = toolMap[name]
        if (!tool) {
          LOG.warn("tool not found", { task, service, name })
          return { id, content: `Error: Tool "${name}" not found` }
        }
        LOG.debug("tool call", { task, service, name, args })
        const t0 = Date.now()
        try {
          const content = await tool.invoke(args)
          const duration = Date.now() - t0 + "ms"
          LOG.debug("tool result", {
            task,
            service,
            name,
            duration,
            result:
              typeof content === "string"
                ? content.slice(0, 200)
                : JSON.stringify(content).slice(0, 200),
          })
          return { id, content }
        } catch (err) {
          const duration = Date.now() - t0 + "ms"
          LOG.error("tool failed", { task, service, name, duration, error: err.message })
          LOG.debug("tool failed stack", { task, service, name, stack: err.stack })
          return { id, content: `Error executing ${name}: ${err.message}` }
        }
      }),
    )
    return {
      messages: results.map((r) => new ToolMessage({ content: r.content, tool_call_id: r.id })),
    }
  }

  function shouldContinue(state, config) {
    if (state.iterations >= MAX_ITERATIONS) {
      const task = short(config?.configurable?._taskId)
      const service = config?.configurable?._service
      LOG.warn("Max iterations reached", { task, service, iterations: state.iterations })
      return "end"
    }
    return state.toolCalls?.length > 0 ? "tools" : "end"
  }

  return { agentNode, toolNode, shouldContinue }
}

module.exports = { createNodes }
