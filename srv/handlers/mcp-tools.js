import cds from "@sap/cds"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { mcpClient } from "../../lib/remote/mcp.js"
import { outboundConnection } from "../../lib/remote/http.js"
import { generateTools } from "../../lib/agents/tools.js"
import { toolName, mcpToolKind } from "../../lib/utils/utils.js"

const LOG = cds.log("agents:mcp")

export async function buildMcpTools(serviceName) {
  return cds.requires[serviceName]?.credentials
    ? buildMcpToolsFromConnection(serviceName)
    : buildMcpToolsLocally(serviceName)
}

/** Resolve tools in the caller's CDS context; only configuration is captured at startup. */
export async function buildMcpToolsFromConnection(serviceName) {
  const client = mcpClient(outboundConnection(serviceName, "mcp"))
  const toolFilter = cds.requires[serviceName]?.mcp?.tools
  return {
    serviceName,
    _dynamicTools: async () => {
      try {
        const definitions = await client.listTools()
        return definitions
          .filter((definition) => !toolFilter?.length || toolFilter.includes(definition.name))
          .map(
            (definition) =>
              new DynamicStructuredTool({
                name: toolName(serviceName + "_" + definition.name),
                description: definition.description || definition.name,
                schema: definition.inputSchema,
                metadata: {
                  ...definition.annotations,
                  serviceName,
                  kind: mcpToolKind(definition.name),
                },
                responseFormat: "content_and_artifact",
                func: async (args, _runManager, config) => {
                  const result = await client.callTool(definition.name, args, config?.signal)
                  return [toolContent(result), result]
                },
              }),
          )
      } catch (err) {
        LOG.warn('Failed to build MCP tools for "' + serviceName + '": ' + (err?.message ?? err))
        // The middleware caches this result for the request; a new request can retry.
        return []
      }
    },
  }
}

export async function buildMcpToolsLocally(serviceName) {
  const srv = cds.services[serviceName]
  const tools = generateTools(srv)
  const prefix = toolName(`${serviceName}_`)
  for (const tool of tools) {
    // Keep PerActionTool's actionName so status-update can resolve the action's label.
    tool.metadata = {
      ...tool.metadata,
      serviceName,
      kind: mcpToolKind(tool.name),
      ...(tool.actionName && { actionName: tool.actionName }),
    }
    tool.name = `${prefix}${tool.name}`
  }

  LOG.debug(
    `Got ${tools.length} MCP tools from ${serviceName}: ${tools.map((t) => t.name).join(", ")}`,
  )
  return tools
}

function toolContent(result) {
  const content = result.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text }
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: { url: "data:" + part.mimeType + ";base64," + part.data },
      }
    }
    if (part.type === "audio") {
      return { type: "audio", source_type: "base64", mime_type: part.mimeType, data: part.data }
    }
    // Embedded resources and resource links remain readable; the complete MCP result
    // (including binary resources, structuredContent and isError) is kept as the artifact.
    return { type: "text", text: part.resource?.text ?? JSON.stringify(part) }
  })
  if (!content.length && result.structuredContent) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) })
  }
  return content
}
