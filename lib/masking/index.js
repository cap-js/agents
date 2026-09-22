import cds from "@sap/cds"
import { randomBytes } from "node:crypto"
import { toolName as normaliseName } from "../utils/utils.js"
import { PseudonymStore } from "./store.js"
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

export async function ensureSession() {
  if (cds.context?.["agent.pseudonyms"]) return

  const { seed, hashToOriginal, textAnalysisResults } = await readMaskingState()
  const session = new PseudonymStore(seed, hashToOriginal)
  if (textAnalysisResults?.length) session._textAnalysisResults = textAnalysisResults
  cds.context["agent.pseudonyms"] = session
}

async function readMaskingState() {
  const checkpointer = cds.context?.["agent.checkpointer"]
  const thread_id = cds.context?.["agent.graph.thread_id"]
  if (!checkpointer || !thread_id) return {}
  try {
    const tuple = await checkpointer.getTuple({ configurable: { thread_id } })
    const values = tuple?.checkpoint?.channel_values
    if (!values) return {}
    return {
      seed: values.seed,
      hashToOriginal: values.hashToOriginal,
      textAnalysisResults: values.textAnalysisResults,
    }
  } catch {
    return {}
  }
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
