import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import { toolName } from "../../utils/utils.js"

const LOG = cds.log("agents:mcp")

/**
 * Middleware that resolves remote MCP tools per-request using the current user's auth headers.
 * Tools are cached on cds.context.__mcpDynamicTools keyed by mcpUrl for the lifetime of the
 * request so multi-turn ReAct loops don't issue a new tools/list call on every model invocation.
 */
export function remoteMcpMiddleware() {
  return createMiddleware({
    name: "RemoteMcpMiddleware",

    wrapModelCall: async (request, handler) => {
      const cache = (cds.context.__mcpDynamicTools ??= {})
      const placeholders = (request.tools ?? []).filter((t) => t._mcpDynamic)
      const resolved = []
      for (const placeholder of placeholders) {
        const { mcpUrl, resolveHeaders } = placeholder
        if (!cache[mcpUrl]) {
          const headers = await resolveHeaders()
          const client = new MultiServerMCPClient({
            mcpServers: { default: { transport: "http", url: mcpUrl, headers } },
          })
          const raw = await client.getTools()
          const prefix = toolName(`${mcpUrl}_`)
          for (const t of raw) t.name = `${prefix}${t.name}`
          cache[mcpUrl] = raw
          LOG.info(
            `Got ${raw.length} MCP tools from ${mcpUrl}: ${raw.map((t) => t.name).join(", ")}`,
          )
        }
        resolved.push(...cache[mcpUrl])
      }
      const staticTools = (request.tools ?? []).filter((t) => !t._mcpDynamic)
      return handler({ ...request, tools: [...staticTools, ...resolved] })
    },

    wrapToolCall: async (request, handler) => {
      const allCached = Object.values(cds.context.__mcpDynamicTools ?? {}).flat()
      const tool = allCached.find((t) => t.name === request.toolCall.name)
      if (!tool) return handler(request)
      try {
        const output = await tool.invoke(request.toolCall.args)
        return new ToolMessage({
          name: request.toolCall.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: request.toolCall.id,
        })
      } catch (err) {
        LOG.warn(`MCP tool "${request.toolCall.name}" error: ${err.message}`)
        return new ToolMessage({
          name: request.toolCall.name,
          content: `Error: ${err.message}`,
          tool_call_id: request.toolCall.id,
        })
      }
    },
  })
}
