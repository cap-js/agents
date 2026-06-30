import cds from "@sap/cds"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"

const LOG = cds.log("agent:mcp")

/**
 * Resolve URL and HTTP headers for a BTP destination using the Cloud SDK.
 * Passes the incoming user JWT for OAuth2UserTokenExchange destinations.
 * Falls back to CAP's authTokens if Cloud SDK resolution fails.
 *
 * @param {string} destinationName
 * @param {object|string} dest - raw CAP destination value (for fallback)
 * @param {string|null} localUrl - URL already known from CAP (fallback if Cloud SDK has none)
 * @returns {Promise<{ url: string|null, headers: Record<string, string> }>}
 */
async function resolveDestination(destinationName, dest, localUrl) {
  try {
    const { getDestination, buildHeadersForDestination, retrieveJwt } =
      await import("@sap-cloud-sdk/connectivity")
    const jwt = retrieveJwt(cds.context?.http?.req)
    const resolvedDest = await getDestination({ destinationName, jwt })
    if (!resolvedDest) return { url: localUrl, headers: {} }

    const rawHeaders = await buildHeadersForDestination(resolvedDest)
    // Cloud SDK returns lowercase header keys (e.g. "authorization") —
    // normalize to title-case so HTTP clients handle them correctly.
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([k, v]) => [
        k.replace(/(^|-)(.)/g, (_, sep, c) => sep + c.toUpperCase()),
        v,
      ]),
    )
    return { url: resolvedDest.url ?? localUrl, headers }
  } catch (err) {
    LOG.warn(
      `Could not resolve destination "${destinationName}" via Cloud SDK, falling back to CAP destination: ${err.message}`,
    )
    const token = typeof dest === "object" ? dest?.authTokens?.[0]?.value : null
    return { url: localUrl, headers: token ? { Authorization: `Bearer ${token}` } : {} }
  }
}

/**
 * Wrap MCP tool invocations to convert errors into plain string results.
 * deepagents' wrapToolCall middleware marks errors thrown inside it as
 * "middleware errors", which LangChain's ToolNode re-throws rather than
 * converting to a ToolMessage (see ToolNode.js: isMiddlewareError check).
 * MCP tool schema validation errors therefore crash the graph instead of
 * being fed back to the LLM as recoverable feedback.
 */
function wrapToolsWithErrorHandling(tools, serviceName) {
  return tools.map((tool) => {
    const original = tool.invoke.bind(tool)
    tool.invoke = async (args, config) => {
      try {
        return await original(args, config)
      } catch (err) {
        LOG.warn(`MCP tool "${tool.name}" error: ${err.message}`, { service: serviceName })
        return `Error: ${err.message}`
      }
    }
    return tool
  })
}

/**
 * Build LangChain tools from a CAP MCP connection.
 * Resolves the destination URL and auth headers, connects to the MCP server,
 * and returns the tools wrapped with error handling for use in agent graphs.
 *
 * @param {string} serviceName - cds.requires service key
 * @returns {Promise<import("@langchain/core/tools").StructuredTool[]>}
 */
export async function buildMcpToolsFromConnection(serviceName) {
  const svc = await cds.connect.to(serviceName)
  const dest = svc.destination

  // dest is either a string (BTP destination name) or an object { name, url, ... }
  const destinationName = typeof dest === "string" ? dest : dest?.name
  const localUrl = typeof dest === "string" ? null : dest?.url

  if (!localUrl && !destinationName) {
    throw new Error(
      `[mcp-tools] Could not resolve URL or destination name for service "${serviceName}". Check cds.requires config.`,
    )
  }

  const { url, headers } = destinationName
    ? await resolveDestination(destinationName, dest, localUrl)
    : {
        url: localUrl,
        headers: dest?.authTokens?.[0]?.value
          ? { Authorization: `Bearer ${dest.authTokens[0].value}` }
          : {},
      }

  if (destinationName) {
    LOG.debug(`Resolved destination "${destinationName}"`, {
      url,
      headerKeys: Object.keys(headers),
    })
  }

  if (!url) {
    throw new Error(
      `[mcp-tools] Could not resolve URL for service "${serviceName}" after destination lookup.`,
    )
  }

  const mcpUrl = url.replace(/\/$/, "")
  LOG.info(`Connecting to MCP server at ${mcpUrl}`)

  const client = new MultiServerMCPClient({
    mcpServers: {
      [serviceName]: {
        url: mcpUrl,
        ...(Object.keys(headers).length ? { headers } : {}),
      },
    },
  })

  const tools = await client.getTools()
  LOG.info(
    `Got ${tools.length} MCP tools from ${serviceName}: ${tools.map((t) => t.name).join(", ")}`,
  )

  return wrapToolsWithErrorHandling(tools, serviceName)
}
