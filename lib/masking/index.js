import cds from "@sap/cds"
import { toolName as normaliseName } from "../utils/utils.js"
import { PseudonymStore } from "./store.js"
import { hasPersonalDataAnnotations } from "./structured/index.js"

export function resolvePseudonyms(text) {
  if (typeof text !== "string") return text
  return cds.context?.["agent.pseudonyms"]?.resolveText(text) ?? text
}

export async function ensureSession(serviceName) {
  if (cds.context?.["agent.pseudonyms"]) return

  const srv = cds.services?.[serviceName]
  const model = cds.context?.model ?? srv?.model
  let needsMasking = model ? hasPersonalDataAnnotations(model, serviceName) : false
  if (!needsMasking) {
    for (const { serviceName: remoteName } of Object.values(cds.context?.__mcpDynamicTools ?? {})) {
      const remoteSrv = cds.services?.[remoteName]
      const remoteModel = remoteSrv?.model
      if (remoteModel && hasPersonalDataAnnotations(remoteModel, remoteName)) {
        needsMasking = true
        break
      }
    }
    if (!needsMasking) return
  }

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
