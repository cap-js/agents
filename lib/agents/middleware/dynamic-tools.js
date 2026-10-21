import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"

const LOG = cds.log("agents:dynamic-tools")

/**
 * Middleware that resolves dynamic tool placeholders per-request.
 * A placeholder has the shape: { _dynamicTools: async () => Tool[], serviceName: string }
 * Resolved entries are cached on cds.context._dynamicTools keyed by serviceName
 * for the lifetime of the request so multi-turn ReAct loops don't re-fetch.
 */
export function dynamicToolsMiddleware() {
  return createMiddleware({
    name: "DynamicToolsMiddleware",

    wrapModelCall: async (request, handler) => {
      const cache = (cds.context._dynamicTools ??= {})
      const placeholders = (request.tools ?? []).filter((t) => t._dynamicTools)
      await Promise.all(
        placeholders.map(async (placeholder) => {
          if (cache[placeholder.serviceName]) return
          const tools = await placeholder._dynamicTools()
          cache[placeholder.serviceName] = tools
          LOG.debug(`Resolved ${tools.length} dynamic tool(s): ${tools.map((t) => t.name).join(", ")}`)
        }),
      )
      const resolved = placeholders.flatMap((p) => cache[p.serviceName] ?? [])
      const staticTools = (request.tools ?? []).filter((t) => !t._dynamicTools)
      return handler({ ...request, tools: [...staticTools, ...resolved] })
    },

    wrapToolCall: async (request, handler) => {
      const cache = cds.context?._dynamicTools
      if (!cache) return handler(request)
      const allResolved = Object.values(cache).flat()
      const tool = allResolved.find((t) => t?.name === request.toolCall.name)
      if (!tool) return handler(request)
      try {
        const output = await tool.invoke(request.toolCall.args)
        return new ToolMessage({
          name: request.toolCall.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: request.toolCall.id,
        })
      } catch (err) {
        LOG.warn(`Dynamic tool "${request.toolCall.name}" error: ${err.message}`)
        return new ToolMessage({
          name: request.toolCall.name,
          content: `Error: ${err.message}`,
          tool_call_id: request.toolCall.id,
        })
      }
    },
  })
}
