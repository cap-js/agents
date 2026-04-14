const cds = require("@sap/cds")

const LOG = cds.log("a2a")
const MAX_ITERATIONS = 10

function createNodes(model, toolMap) {
  async function agentNode(state) {
    LOG.debug("Agent node", { iteration: state.iterations + 1 })
    LOG.info(
      "→ LLM",
      state.messages.map((m) => m.constructor.name || m._getType?.()),
    )
    const response = await model.invoke(state.messages)
    const toolCalls = response.tool_calls || []
    LOG.debug("Agent response", {
      hasToolCalls: toolCalls.length > 0,
      toolNames: toolCalls.map((tc) => tc.name),
    })
    return {
      messages: [response],
      toolCalls,
      output: response.content,
      iterations: state.iterations + 1,
    }
  }

  async function toolNode(state) {
    const { ToolMessage } = await import("@langchain/core/messages")
    const results = await Promise.all(
      state.toolCalls.map(async (toolCall) => {
        const { name, args, id } = toolCall
        const tool = toolMap[name]
        if (!tool) {
          LOG.warn("Tool not found", { name })
          return { id, content: `Error: Tool "${name}" not found` }
        }
        try {
          LOG.info(" ", name)
          const content = await tool.invoke(args)
          return { id, content }
        } catch (err) {
          LOG.error(" ", name, ">", "failed", err.message)
          return { id, content: `Error executing ${name}: ${err.message}` }
        }
      }),
    )
    return {
      messages: results.map((r) => new ToolMessage({ content: r.content, tool_call_id: r.id })),
    }
  }

  function shouldContinue(state) {
    if (state.iterations >= MAX_ITERATIONS) {
      LOG.debug("Max iterations reached")
      return "end"
    }
    return state.toolCalls?.length > 0 ? "tools" : "end"
  }

  return { agentNode, toolNode, shouldContinue }
}

module.exports = { createNodes }
