import cds from "@sap/cds"
import { toolName as normaliseName } from "../utils/utils.js"

export function resolvePseudonyms(text) {
  if (typeof text !== "string") return text
  return cds.context?.["agent.pseudonyms"]?.resolveText(text) ?? text
}

// For a remote MCP tool name like "catalogservice_query", strip the service prefix
// and return { bareName, remoteSrv }.  Returns null for local tools.
export function resolveRemoteMcpTool(prefixedName) {
  const cache = cds.context?.__mcpDynamicTools
  if (!cache) return null
  for (const { serviceName, tools } of Object.values(cache)) {
    const prefix = normaliseName(`${serviceName}_`)
    if (!tools?.some((t) => t.name === prefixedName)) continue
    // If multiple CAP MCPs are included its possible that one of the CAP MCPs owns query if the agent itself does not expose any entities
    return {
      bareName: prefixedName.startsWith(prefix) ? prefixedName.slice(prefix.length) : prefixedName,
      remoteSrv: cds.services?.[serviceName],
    }
  }
  return null
}
