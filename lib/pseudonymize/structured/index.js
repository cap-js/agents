import cds from "@sap/cds"
import { decode, encode } from "@toon-format/toon"
import {
  shouldHash,
  personalDataElements,
  actionReturnElements,
  discoverElementsToBeMasked,
  hasPersonalDataAnnotations,
} from "./findElements.js"

export {
  shouldHash,
  personalDataElements,
  actionReturnElements,
  discoverElementsToBeMasked,
  hasPersonalDataAnnotations,
}

export function pseudonymizationThreadId(serviceName, contextId) {
  const tenant = cds.context?.tenant ?? "_"
  const user = cds.context?.user?.id ?? "anonymous"
  return `${serviceName}:${tenant}:${user}:${contextId}`
}

export function pseudonymizeData(data, annotatedFields, session) {
  if (!annotatedFields.size) return
  const rows = Array.isArray(data) ? data : data ? [data] : []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    for (const field of annotatedFields) {
      if (Array.isArray(field)) {
        // Path array from expand: ["author", "name"] → traverse row.author (array or object)
        // and pseudonymize the leaf field in each nested row.
        const [first, ...rest] = field
        const nested = row[first]
        if (nested != null) pseudonymizeData(nested, new Set([rest.length === 1 ? rest[0] : rest]), session)
      } else {
        if (!(field in row) || row[field] == null) continue
        row[field] = session.pseudonymize(row[field], field)
      }
    }
  }
}

export function resolveArgs(value, session) {
  if (typeof value === "string") return session.resolveText(value)
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, session))
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveArgs(v, session)
    return out
  }
  return value
}

// Decode TOON tool result, hash personal-data fields, re-encode. Unchanged on
// no-op or error. Idempotent per value → middleware + tool-tracing agree.
// forLlm=true (default): skip @Common.Masked:false fields (LLM is allowed to see them).
// forLlm=false: also include fields where @Common.Masked is present (any value) — used
// when scrubbing spans, where UI-masking annotations still imply PII in traces.
// model/srv/session are optional: when omitted they are resolved from cds.context
// (middleware call path); when provided they are used directly (span-masking call path).
export function pseudonymizeToolResult({ content, toolName, cql, model, srv, session, forLlm = true }) {
  if (typeof content !== "string" || !content) return content
  const _session = session ?? cds.context?._pseudoSession
  if (!_session) return content
  const srvName = cds.context?.["agent.service"]
  const _srv = srv ?? cds.services?.[srvName]
  const _model = model ?? cds.context?.model ?? _srv?.model
  if (!_srv || !_model) return content
  try {
    const decoded = decode(content)
    const annotatedFields =
      toolName === "query"
        ? discoverElementsToBeMasked(_model, _srv, cql, forLlm)
        : actionReturnElements(_model, _srv, toolName, forLlm)
    // REVISIT: ensure functions also return .data instead of .result
    if ((!decoded?.data && !decoded?.result) || !annotatedFields.size) return content
    pseudonymizeData(decoded.data ?? decoded.result, annotatedFields, _session)
    return encode(decoded)
  } catch {
    return content
  }
}
