import cds from "@sap/cds"
import { randomBytes } from "node:crypto"
import { toolName as normaliseName } from "../utils/utils.js"
import { PseudonymStore } from "./store.js"
import { loadPseudonymSession, savePseudonymSession } from "./persistence.js"
import { pseudonymizeToolResult } from "./structured/index.js"
import anonymizeUnstructured from "./unstructured/index.js"

export function resolvePseudonyms(text) {
  if (typeof text !== "string") return text
  return cds.context?.["agent.pseudonyms"]?.resolveText(text) ?? text
}

/**
 * Input:  { data, type, seed?, metadata? }
 * Output: { data, mappings?, metadata: { textAnalysisResults?, seed, type } }
 */
export async function pseudonymize({ data, type, seed, metadata }, srv) {
  const effectiveSeed = seed ?? randomBytes(16).toString("hex")
  const result = { metadata: { seed: effectiveSeed, type } }

  if (type === "unstructured") {
    const r = await anonymizeUnstructured(data, effectiveSeed)
    result.data = r.text
    if (r.mappings?.length) result.mappings = r.mappings
    if (r.textAnalysisResults) result.metadata.textAnalysisResults = r.textAnalysisResults
  } else {
    // data is a decoded object (caller handles TOON/JSON decode+encode)
    const toolName = metadata?.toolName
    const srvName = metadata?.serviceName ?? srv?.name
    const targetSrv = cds.services?.[srvName] ?? srv
    const model = targetSrv?.model

    const store = new PseudonymStore(effectiveSeed)

    pseudonymizeToolResult({
      decoded: data,
      toolName,
      cql: metadata?.cql,
      strictMasking: metadata?.strictMasking ?? false,
      session: store,
      srv: targetSrv,
      model,
    })
    result.data = data

    if (store._hashToOriginal.size) result.mappings = [...store._hashToOriginal]
  }

  return result
}

export async function ensureSession(sessionId = cds.context?.["agent.context.id"]) {
  if (cds.context?.["agent.pseudonyms"]) return
  const { mappings } = await loadPseudonymSession(sessionId)
  const session = new PseudonymStore(sessionId, mappings)
  cds.context["agent.pseudonyms"] = session
}

export async function saveSession(sessionId = cds.context?.["agent.context.id"]) {
  await savePseudonymSession(sessionId, cds.context?.["agent.pseudonyms"])
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
