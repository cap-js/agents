import cds from "@sap/cds"
import {
  shouldHash,
  personalDataElements,
  discoverElementsToBeMasked,
  hasPersonalDataAnnotations,
  hasPersonalDataAnnotation,
  actionReturnType,
} from "./findElements.js"

export { shouldHash, personalDataElements, discoverElementsToBeMasked, hasPersonalDataAnnotations }

/**
 * Check whether masking is needed for a service — local model + remote MCP models.
 */
export function needsMasking(serviceName) {
  const srv = cds.services?.[serviceName]
  const model = cds.context?.model ?? srv?.model
  if (model && hasPersonalDataAnnotations(model, serviceName)) return true
  for (const { serviceName: remoteName } of Object.values(cds.context?.__mcpDynamicTools ?? {})) {
    const remoteSrv = cds.services?.[remoteName]
    const remoteModel = remoteSrv?.model
    if (remoteModel && hasPersonalDataAnnotations(remoteModel, remoteName)) return true
  }
  return false
}

export function pseudonymizeData(data, annotatedFields, session) {
  if (!annotatedFields.size) return
  const rows = Array.isArray(data) ? data : data ? [data] : []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    for (const field of annotatedFields) {
      if (Array.isArray(field) && field.length > 1) {
        // Multi-segment path: nested ({address:{street}}) or CAP-flattened ({address_street}).
        const [first, ...rest] = field
        if (first in row && row[first] != null && typeof row[first] === "object") {
          pseudonymizeData(row[first], new Set([rest.length === 1 ? rest[0] : rest]), session)
        } else {
          const flat = field.join("_")
          if (flat in row && row[flat] != null) {
            const v = row[flat]
            row[flat] = Array.isArray(v)
              ? v.map((x) => (x == null ? x : session.pseudonymize(x, flat)))
              : session.pseudonymize(v, flat)
          }
        }
      } else {
        // Plain name or single-element path array ["nicknames"].
        const name = Array.isArray(field) ? field[0] : field
        if (!(name in row) || row[name] == null) continue
        const value = row[name]
        // Scalar array — hash each element.
        row[name] = Array.isArray(value)
          ? value.map((v) => (v == null ? v : session.pseudonymize(v, name)))
          : session.pseudonymize(value, name)
      }
    }
  }
}

export function resolveArgs(value, session) {
  if (!session?._hashToOriginal?.size) return value
  if (typeof value === "string") return session.resolveText(value)
  if (Array.isArray(value)) {
    const mapped = value.map((v) => resolveArgs(v, session))
    return mapped.every((v, i) => v === value[i]) ? value : mapped
  }
  if (value && typeof value === "object") {
    let changed = false
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const resolved = resolveArgs(v, session)
      out[k] = resolved
      if (resolved !== v) changed = true
    }
    return changed ? out : value
  }
  return value
}

// Walk a CDS type definition recursively alongside `data`, hashing PII leaves.
// Covers action/function return shapes: named type refs, structs, arrays, scalar arrays.
// Depth guard (20) prevents runaway on self-referential types.
function pseudonymizeByType(data, typeDef, propName, session, model, strictMasking, depth = 0) {
  if (data == null || typeDef == null || depth > 20) return data

  // Named type ref → resolve then recurse; unresolved scalar → hash if PII.
  if (typeDef.type && !typeDef.elements && !typeDef.items) {
    const resolved = model.definitions?.[typeDef.type]
    if (resolved)
      return pseudonymizeByType(data, resolved, propName, session, model, strictMasking, depth + 1)
    if (shouldHash(typeDef) && hasPersonalDataAnnotation(typeDef)) {
      if (!strictMasking && typeDef["@Common.Masked"] === false) return data
      return session.pseudonymize(data, propName)
    }
    return data
  }

  // Array: `many String @PersonalData` carries the annotation on the arrayed node, not
  // on items — detect and hash each scalar directly; otherwise recurse per item.
  if (typeDef.items) {
    if (!Array.isArray(data)) return data
    const scalarPii =
      hasPersonalDataAnnotation(typeDef) &&
      !typeDef.items.elements &&
      !typeDef.items.items &&
      shouldHash(typeDef.items)
    if (scalarPii && (strictMasking || typeDef["@Common.Masked"] !== false))
      return data.map((item) => (item == null ? item : session.pseudonymize(item, propName)))
    return data.map((item) =>
      pseudonymizeByType(item, typeDef.items, propName, session, model, strictMasking, depth + 1),
    )
  }

  // Struct → recurse into each element.
  if (typeDef.elements) {
    if (typeof data !== "object" || Array.isArray(data)) return data
    for (const [name, elDef] of Object.entries(typeDef.elements)) {
      if (!(name in data) || data[name] == null) continue
      data[name] = pseudonymizeByType(
        data[name],
        elDef,
        name,
        session,
        model,
        strictMasking,
        depth + 1,
      )
    }
    return data
  }

  // Inline scalar leaf.
  if (shouldHash(typeDef) && hasPersonalDataAnnotation(typeDef)) {
    if (!strictMasking && typeDef["@Common.Masked"] === false) return data
    return session.pseudonymize(data, propName)
  }
  return data
}

// Pseudonymize PII in a decoded tool result object (mutates in place).
// Queries: CQL-derived field discovery. Actions/functions: recursive type walk.
export function pseudonymizeToolResult({
  decoded,
  toolName,
  cql,
  strictMasking = false,
  session,
  srv,
  model,
}) {
  if (!decoded || !session || !srv || !model) return
  const payload = decoded?.data ?? decoded?.result
  if (payload == null) return

  if (toolName === "query" || toolName.endsWith("_query")) {
    const annotatedFields = discoverElementsToBeMasked(model, srv, cql, strictMasking)
    if (!annotatedFields.size) return
    pseudonymizeData(payload, annotatedFields, session)
    return
  }

  // Action/function: walk return-type definition. Top-level scalar has no element
  // name → use tool name as hash prefix.
  const returnType = actionReturnType(model, srv, toolName)
  if (!returnType) return
  const key = decoded.data != null ? "data" : "result"
  decoded[key] = pseudonymizeByType(payload, returnType, toolName, session, model, strictMasking)
}
