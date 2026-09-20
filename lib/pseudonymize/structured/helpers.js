import cds from "@sap/cds"
import { decode, encode } from "@toon-format/toon"

const PERSONAL_DATA_CACHE = Symbol.for("@cap-js/agents:personalDataPaths")

const STRING_TYPES = new Set(["cds.String", "cds.UUID", "cds.LargeString"])
const NUMERIC_TYPES = new Set(["cds.Integer", "cds.Integer64", "cds.Decimal", "cds.Double"])

const PD_TAGS = [
  "@PersonalData.IsPotentiallyPersonal",
  "@PersonalData.IsPotentiallySensitive",
  "@Common.Masked",
]
function hasPersonalDataAnnotation(element) {
  if (
    PD_TAGS.some((a) => element[a] != null && element[a] !== false) ||
    element["@PersonalData.FieldSemantics"] === "DataSubjectID" ||
    element["@PersonalData.FieldSemantics"] === "UserID"
  ) {
    return true
  }
  return false
}

export function shouldHash(el) {
  if (STRING_TYPES.has(el.type)) return true
  if (NUMERIC_TYPES.has(el.type)) return !!(el.key || el._foreignKey4)
  return false
}

export function personalDataElements(entityDef, forLlm = true) {
  if (!entityDef?.elements) return new Set()
  const result = new Set()
  for (const [name, el] of Object.entries(entityDef.elements)) {
    if (!shouldHash(el)) continue
    if (!hasPersonalDataAnnotation(el)) continue
    // forLlm=true: skip @Common.Masked:false — LLM is allowed to see those fields.
    // forLlm=false: include @Common.Masked even if false
    if (forLlm && el["@Common.Masked"] === false) continue
    result.add(name)
  }
  return result
}

// Memoize computed sets on the model via a Symbol; auto-invalidates when the
// model is rebuilt (e.g. on feature toggle) because a new model object is used.
function cache(model, key, compute) {
  model[PERSONAL_DATA_CACHE] ??= {}
  if (model[PERSONAL_DATA_CACHE][key] !== undefined) return model[PERSONAL_DATA_CACHE][key]
  return (model[PERSONAL_DATA_CACHE][key] = compute())
}

export function actionReturnElements(model, srv, actionName, forLlm) {
  return cache(model, `action:${srv.name}.${actionName}:${forLlm}`, () => {
    const def = model.definitions?.[`${srv.name}.${actionName}`]
    let entityDef = def?.returns
    if (entityDef?.type && !entityDef.elements) entityDef = model.definitions?.[entityDef.type]
    return personalDataElements(entityDef, forLlm)
  })
}

// Resolve a single FROM source ("{ ref, as }") to its entity definition and the
// alias it is referenced by. Returns null if it can't be resolved.
function _resolveSource(model, srv, node) {
  const ref = node?.ref
  const raw = typeof ref?.[0] === "string" ? ref[0] : ref?.[0]?.id
  if (!raw) return null
  const localName = raw.includes(".") ? raw : `${srv.name}.${raw}`
  const entityDef = model.definitions?.[localName] ?? model.definitions?.[raw]
  if (!entityDef) return null
  // Alias defaults to the last segment of the entity name (CQL default alias).
  const alias = node.as ?? raw.split(".").pop()
  return { alias, entityDef }
}

// Walk a FROM clause (which may be a nested join tree or subquery) and collect
// every source entity keyed by its alias. Joins nest via { join, args: [...] }.
// Subqueries surface as { SELECT: { from, columns } } — we recurse into the
// inner FROM so the entity annotations are still reachable from the outer query.
function _collectSources(model, srv, from, out = new Map()) {
  if (!from) return out
  if (Array.isArray(from.args)) {
    for (const arg of from.args) _collectSources(model, srv, arg, out)
    return out
  }
  if (from.SELECT) {
    return _collectSources(model, srv, from.SELECT.from, out)
  }
  const src = _resolveSource(model, srv, from)
  if (src) out.set(src.alias, src)
  return out
}

// Build an alias map from a subquery's columns: outerName → innerRef[].
// Used when FROM is a subquery so outer column names can be traced back to
// the original entity elements (including navigation paths like author.name).
// e.g. [{ ref:["name"], as:"ab" }]  →  { ab: ["name"] }
//      [{ ref:["author","name"], as:"ab" }]  →  { ab: ["author","name"] }
//      [{ ref:["name"] }]  →  { name: ["name"] }  (identity)
function _subqueryAliasMap(subqueryCols) {
  if (!Array.isArray(subqueryCols)) return null
  const map = new Map()
  for (const col of subqueryCols) {
    if (!col?.ref?.length) continue
    const outerName = col.as ?? col.ref[col.ref.length - 1]
    map.set(outerName, col.ref)
  }
  return map.size ? map : null
}

export function discoverElementsToBeMasked(model, srv, cql, forLlm) {
  if (!cql) return new Set()
  return cache(model, `query:${srv.name}:${cql}:${forLlm}`, () => {
    let cqn
    try {
      cqn = cds.parse.cql(cql)
    } catch {
      return new Set()
    }
    return _discoverFromCqn(model, srv, cqn, forLlm)
  })
}

function _discoverFromCqn(model, srv, cqn, forLlm) {
    // UNION / INTERSECT / EXCEPT: collect masked fields from every branch and
    // union the result sets — a field that is PII in any branch must be masked.
    if (cqn.SET) {
      const all = new Set()
      for (const branch of cqn.SET.args ?? []) {
        for (const f of _discoverFromCqn(model, srv, branch, forLlm)) all.add(f)
      }
      return all
    }

    const from = cqn.SELECT?.from

    // All source entities (single entity → one; join → many), keyed by alias,
    // each with its own set of personal-data element names.
    const sources = _collectSources(model, srv, from)
    if (!sources.size) return new Set()
    const annotatedByAlias = new Map()
    for (const [alias, { entityDef }] of sources) {
      annotatedByAlias.set(alias, personalDataElements(entityDef, forLlm))
    }

    // When FROM is a subquery, outer column names may differ from entity element
    // names (e.g. `SELECT ab FROM (SELECT name as ab FROM Authors)`).
    // Build a map from the subquery's output column names back to their inner refs
    // so the outer projection can be resolved to entity elements.
    const subqueryAliasMap = from?.SELECT ? _subqueryAliasMap(from.SELECT.columns) : null

    const columns = cqn.SELECT?.columns
    const anyAnnotated = [...annotatedByAlias.values()].some((s) => s.size)
    // Navigation path columns (e.g. author.name) reference annotated elements on
    // associated entities — their annotations don't appear on the source entity.
    // Don't bail early when any explicit column uses a multi-segment path, or when
    // a subquery alias map resolves to a multi-segment ref, or when expand columns
    // reference annotated associations.
    const hasNavigationCol =
      (columns && columns.some((c) => Array.isArray(c?.ref) && (c.ref.length > 1 || c.expand))) ||
      (subqueryAliasMap && [...subqueryAliasMap.values()].some((r) => r.length > 1))
    if (!anyAnnotated && !hasNavigationCol) return new Set()

    // SELECT * (or no explicit projection): every source's annotated elements
    // surface under their plain element names. (Single-source is the common
    // case; for a join with '*' the result keys are the element names too.)
    if (!columns || columns.some((c) => c === "*")) {
      const all = new Set()
      for (const s of annotatedByAlias.values()) for (const n of s) all.add(n)
      return all
    }

    // Explicit projection: resolve each column to the source it belongs to and
    // keep it only if the underlying element is personal data. The result key
    // is the alias (if any) else the element name — so aliased and
    // table-qualified join columns still get hashed.
    const resultNames = new Set()
    const singleAlias = sources.size === 1 ? [...sources.keys()][0] : null
    // For navigation paths like `author.name as author`: ref[0] may be an
    // association name rather than a table alias. Precompute a lookup from
    // association name → target entity def for the single source entity.
    const singleEntityDef = singleAlias ? sources.get(singleAlias)?.entityDef : null
    for (const col of columns) {
      // Expand column: SELECT author { name } FROM Books
      // Navigate the association chain and check expanded sub-columns for PII.
      // Each PII sub-column is returned as a path array e.g. ["author", "name"]
      // so pseudonymizeData can traverse the nested row object.
      if (col.expand && col.ref?.length) {
        const assocPath = col.as ? [col.as] : [...col.ref]
        const firstSeg = col.ref.length > 1 ? col.ref[0] : singleAlias
        let targetDef = annotatedByAlias.has(firstSeg)
          ? sources.get(firstSeg)?.entityDef
          : singleEntityDef
        for (const seg of col.ref) {
          const assocEl = targetDef?.elements?.[seg]
          targetDef = assocEl?.target ? model.definitions?.[assocEl.target] : undefined
        }
        if (targetDef) {
          const expandAnnotated = personalDataElements(targetDef, forLlm)
          for (const expandCol of col.expand) {
            // Nested expand: recurse and prepend the current assocPath
            if (expandCol.expand && expandCol.ref?.length) {
              const innerAssocName = expandCol.as ?? expandCol.ref[expandCol.ref.length - 1]
              const innerFirstSeg = expandCol.ref.length > 1 ? expandCol.ref[0] : null
              let innerTargetDef = innerFirstSeg
                ? targetDef?.elements?.[innerFirstSeg]?._target
                    ? model.definitions?.[targetDef.elements[innerFirstSeg].target]
                    : undefined
                : undefined
              for (let i = innerFirstSeg ? 1 : 0; i < expandCol.ref.length && innerTargetDef; i++) {
                const el = innerTargetDef?.elements?.[expandCol.ref[i]]
                innerTargetDef = el?.target ? model.definitions?.[el.target] : undefined
              }
              if (!innerTargetDef) {
                // fall back: resolve full ref from targetDef
                innerTargetDef = targetDef
                for (const seg of expandCol.ref) {
                  const el = innerTargetDef?.elements?.[seg]
                  innerTargetDef = el?.target ? model.definitions?.[el.target] : undefined
                }
              }
              if (innerTargetDef) {
                const innerAnnotated = personalDataElements(innerTargetDef, forLlm)
                for (const innerCol of expandCol.expand) {
                  const innerEl = innerCol?.ref?.[innerCol.ref.length - 1]
                  if (innerEl && innerAnnotated.has(innerEl)) {
                    resultNames.add([...assocPath, innerAssocName, innerEl])
                  }
                }
              }
              continue
            }
            const expandEl = expandCol?.ref?.[expandCol.ref.length - 1]
            if (expandEl && expandAnnotated.has(expandEl)) {
              resultNames.add([...assocPath, expandCol.as ?? expandEl])
            }
          }
        }
        continue
      }

      const outerRef = col?.ref
      if (!outerRef?.length) continue

      // If this query selects from a subquery, resolve the outer column name
      // back to the inner ref (which may be a navigation path like author.name).
      const ref = subqueryAliasMap?.get(outerRef[outerRef.length - 1]) ?? outerRef

      const element = ref[ref.length - 1]
      // Qualified ref "alias.element" → use ref[0] as alias; else the sole source.
      const firstSegment = ref.length > 1 ? ref[0] : singleAlias
      let annotated = annotatedByAlias.get(firstSegment)
      if (!annotated && singleEntityDef && ref.length > 1) {
        // ref[0] is not a table alias — treat it as a navigation path through
        // an association on the single source entity (e.g. author.name).
        // Walk each path segment except the last to resolve the target entity.
        let entityDef = singleEntityDef
        for (let i = 0; i < ref.length - 1 && entityDef; i++) {
          const assocEl = entityDef.elements?.[ref[i]]
          const target = assocEl?.target
          entityDef = target ? model.definitions?.[target] : undefined
        }
        if (entityDef) annotated = personalDataElements(entityDef, forLlm)
      }
      if (!annotated?.has(element)) continue
      // Result key: outer alias if present, else the outer column name (last segment of outerRef)
      resultNames.add(col.as ?? outerRef[outerRef.length - 1])
    }
    return resultNames
}

export function hasPersonalDataAnnotations(model, serviceName) {
  return cache(model, `hasAny:${serviceName}`, () =>
    Object.entries(model.definitions ?? {}).some(([name, def]) => {
      if (!name.startsWith(serviceName + ".") && name !== serviceName) return false
      if (!def.elements) return false
      return Object.values(def.elements).some((el) => hasPersonalDataAnnotation(el))
    }),
  )
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
export function pseudonymizeToolResult({ content, toolName, cql, forLlm = true }) {
  const session = cds.context?._pseudoSession
  if (typeof content !== "string" || !content) return content

  const srvName = cds.context?.["agent.service"]
  const srv = cds.services?.[srvName]
  const model = cds.context?.model ?? srv?.model
  if (!srv || !model) return content

  try {
    const decoded = decode(content)
    const annotatedFields =
      toolName === "query"
        ? discoverElementsToBeMasked(model, srv, cql, forLlm)
        : actionReturnElements(model, srv, toolName, forLlm)
    // REVISIT: ensure functions also return .data instead of .result
    if ((!decoded?.data && !decoded?.result) || !annotatedFields.size) return content
    pseudonymizeData(decoded.data ?? decoded.result, annotatedFields, session)
    return encode(decoded)
  } catch {
    return content
  }
}

export function pseudonymizationThreadId(serviceName, contextId) {
  const tenant = cds.context?.tenant ?? "_"
  const user = cds.context?.user?.id ?? "anonymous"
  return `${serviceName}:${tenant}:${user}:${contextId}`
}
