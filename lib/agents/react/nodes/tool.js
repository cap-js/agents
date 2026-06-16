import cds from "@sap/cds"
import { short } from "../../../utils/utils.js"

const LOG = cds.log("agent")

export default (toolMap) =>
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
      _totalToolCalls: state.toolCalls.length,
    }
  }
