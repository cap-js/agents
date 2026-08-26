import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import { toolName } from "../../utils/utils.js"

const LOG = cds.log("agents:mcp")

/**
 * Middleware that resolves remote MCP tools per-request using the current user's auth headers.
 * Tools are cached on cds.context.__mcpDynamicTools for the lifetime of the request so
 * multi-turn ReAct loops don't issue a new tools/list call on every model invocation.
 *
 * @param {{ serviceName: string, mcpUrl: string, resolveHeaders: () => Promise<object> }} placeholder
 */
export function remoteMcpMiddleware({ serviceName, mcpUrl, resolveHeaders }) {
  const prefix = toolName(`${serviceName}_`)

  return createMiddleware({
    name: `RemoteMcpMiddleware_${serviceName}`,

    wrapModelCall: async (request, handler) => {
      const cache = (cds.context.__mcpDynamicTools ??= {})
      if (!cache[serviceName]) {
        const headers = await resolveHeaders()
        const client = new MultiServerMCPClient({
          mcpServers: { [serviceName]: { transport: "http", url: mcpUrl, headers } },
        })
        const raw = await client.getTools()
        for (const t of raw) t.name = `${prefix}${t.name}`
        cache[serviceName] = raw
        LOG.info(
          `Got ${raw.length} MCP tools from ${serviceName}: ${raw.map((t) => t.name).join(", ")}`,
        )
      }
      return handler({ ...request, tools: [...(request.tools ?? []), ...cache[serviceName]] })
    },

    wrapToolCall: async (request, handler) => {
      if (!request.toolCall.name.startsWith(prefix)) return handler(request)
      const tools = cds.context.__mcpDynamicTools?.[serviceName] ?? []
      const tool = tools.find((t) => t.name === request.toolCall.name)
      if (!tool) return handler(request)
      try {
        const output = await tool.invoke(request.toolCall.args)
        return new ToolMessage({
          name: request.toolCall.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: request.toolCall.id,
        })
      } catch (err) {
        LOG.warn(`MCP tool "${request.toolCall.name}" error: ${err.message}`, {
          service: serviceName,
        })
        return new ToolMessage({
          name: request.toolCall.name,
          content: `Error: ${err.message}`,
          tool_call_id: request.toolCall.id,
        })
      }
    },
  })
}
