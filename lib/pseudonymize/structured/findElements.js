import cds from "@sap/cds"

const PERSONAL_DATA_CACHE = Symbol.for("@cap-js/agents:personalDataPaths")

const STRING_TYPES = new Set(["cds.String", "cds.UUID", "cds.LargeString"])
const NUMERIC_TYPES = new Set(["cds.Integer", "cds.Integer64", "cds.Decimal", "cds.Double"])

const PD_TAGS = [
  "@PersonalData.IsPotentiallyPersonal",
  "@PersonalData.IsPotentiallySensitive",
  "@Common.Masked",
]

function hasPersonalDataAnnotation(element) {
  return (
    PD_TAGS.some((a) => element[a] != null && element[a] !== false) ||
    element["@PersonalData.FieldSemantics"] === "DataSubjectID" ||
    element["@PersonalData.FieldSemantics"] === "UserID"
  )
}

export function shouldHash(el) {
  if (STRING_TYPES.has(el.type)) return true
  if (NUMERIC_TYPES.has(el.type)) return !!(el.key || el._foreignKey4)
  return false
}

// Returns the set of hashable @PersonalData element names for an entity.
// forLlm=false: also includes @Common.Masked:false fields (traces must not expose them).
export function personalDataElements(entityDef, forLlm = true) {
  if (!entityDef?.elements) return new Set()
  const result = new Set()
  for (const [name, el] of Object.entries(entityDef.elements)) {
    if (!shouldHash(el)) continue
    if (!hasPersonalDataAnnotation(el)) continue
    if (forLlm && el["@Common.Masked"] === false) continue
    result.add(name)
  }
  return result
}

// Model-level memoization; invalidates automatically when the model object changes.
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

export function hasPersonalDataAnnotations(model, serviceName) {
  return cache(model, `hasAny:${serviceName}`, () =>
    Object.entries(model.definitions ?? {}).some(([name, def]) => {
      if (!name.startsWith(serviceName + ".") && name !== serviceName) return false
      if (!def.elements) return false
      return Object.values(def.elements).some((el) => hasPersonalDataAnnotation(el))
    }),
  )
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

// Resolve { ref, as? } to its entity def + alias. Returns null when unresolvable.
function _resolveSource(model, srv, node) {
  const ref = node?.ref
  const raw = typeof ref?.[0] === "string" ? ref[0] : ref?.[0]?.id
  if (!raw) return null
  const localName = raw.includes(".") ? raw : `${srv.name}.${raw}`
  const entityDef = model.definitions?.[localName] ?? model.definitions?.[raw]
  if (!entityDef) return null
  const alias = node.as ?? raw.split(".").pop()
  return { alias, entityDef }
}

// Collect all source entities from a FROM clause into a Map keyed by alias.
// Handles: plain ref, JOIN ({ join, args }), subquery ({ SELECT }), union-in-FROM ({ SET }).
// The primary (leading) source is additionally registered under the key `null`, so
// callers can resolve unqualified refs and unqualified expand roots without knowing
// the alias — even in joins where the primary source carries an alias.
function _collectSources(model, srv, from, out = new Map()) {
  if (!from) return out
  if (Array.isArray(from.args)) {
    for (const arg of from.args) _collectSources(model, srv, arg, out)
    return out
  }
  if (from.SELECT) return _collectSources(model, srv, from.SELECT.from, out)
  if (from.SET) {
    for (const branch of from.SET.args ?? [])
      if (branch.SELECT) _collectSources(model, srv, branch.SELECT.from, out)
    return out
  }
  const src = _resolveSource(model, srv, from)
  if (src) {
    out.set(src.alias, src)
    if (!out.has(null)) out.set(null, src) // first resolved source is the primary
  }
  return out
}

// Extract all ref arrays from xpr/func.args nodes (not into SELECT — see _extractSubselects).
function _extractRefs(node) {
  if (!node) return []
  if (Array.isArray(node)) return node.flatMap(_extractRefs)
  if (typeof node !== "object") return []
  if (node.SELECT) return []
  if (node.ref) return [node.ref]
  if (node.xpr) return _extractRefs(node.xpr)
  if (node.args) return _extractRefs(node.args)
  return []
}

// Extract all scalar subselect nodes ({ SELECT }) from xpr/func.args.
function _extractSubselects(node) {
  if (!node) return []
  if (Array.isArray(node)) return node.flatMap(_extractSubselects)
  if (typeof node !== "object") return []
  if (node.SELECT) return [node]
  const found = []
  if (node.xpr) found.push(..._extractSubselects(node.xpr))
  if (node.args) found.push(..._extractSubselects(node.args))
  return found
}

// True when a ref resolves to a PII element via annotatedByAlias or nav-path traversal.
function _isRefPii(ref, annotatedByAlias, primaryEntity, model) {
  if (!ref?.length) return false
  const element = ref[ref.length - 1]

  // Unqualified: binds to whichever source has the element.
  if (ref.length === 1) {
    for (const annotated of annotatedByAlias.values()) if (annotated.has(element)) return true
    return false
  }

  // Qualified: ref[0] is a table alias, or an association path on the primary source.
  let annotated = annotatedByAlias.get(ref[0])
  if (!annotated && primaryEntity) {
    let entityDef = primaryEntity
    for (let i = 0; i < ref.length - 1 && entityDef; i++) {
      const assocEl = entityDef.elements?.[ref[i]]
      entityDef = assocEl?.target ? model.definitions?.[assocEl.target] : undefined
    }
    if (entityDef) annotated = personalDataElements(entityDef)
  }
  return annotated?.has(element) ?? false
}

// Recursively walk expand columns under `expandCols` rooted at `entityDef`.
// Emits path arrays like ["author","contact","email"] into `out` for every PII leaf.
// assocPath: path segments accumulated so far (e.g. ["author","contact"]).
function _expandPiiPaths(model, srv, entityDef, expandCols, assocPath, forLlm, out) {
  if (!entityDef || !expandCols) return
  const annotated = personalDataElements(entityDef, forLlm)
  for (const expandCol of expandCols) {
    if (expandCol.SELECT && expandCol.as) {
      if (_discoverFromCqn(model, srv, expandCol, forLlm).size > 0)
        out.add([...assocPath, expandCol.as])
      continue
    }
    const colName = expandCol.ref?.[expandCol.ref.length - 1]
    if (!colName) continue
    if (expandCol.expand) {
      const assocEl = entityDef.elements?.[colName]
      const targetDef = assocEl?.target ? model.definitions?.[assocEl.target] : undefined
      _expandPiiPaths(
        model,
        srv,
        targetDef,
        expandCol.expand,
        [...assocPath, expandCol.as ?? colName],
        forLlm,
        out,
      )
    } else if (annotated.has(colName)) {
      out.add([...assocPath, expandCol.as ?? colName])
    }
  }
}

// Map a set of inner PII field names through the outer SELECT's columns.
// `byInnerName`: true → look up col.ref[last] (subquery rename), result key = col.as ?? innerName.
//                false → look up col.as ?? col.ref[last] directly (union, no rename).
// SELECT * (or no columns) passes the inner set through unchanged.
function _mapThroughColumns(columns, innerPii, byInnerName) {
  if (!columns || columns.some((c) => c === "*")) return innerPii
  const result = new Set()
  for (const col of columns) {
    const lastRef = col.ref?.[col.ref.length - 1]
    if (byInnerName) {
      if (lastRef && innerPii.has(lastRef)) result.add(col.as ?? lastRef)
    } else {
      const name = col.as ?? lastRef
      if (name && innerPii.has(name)) result.add(name)
    }
  }
  return result
}

// Resolve a plain ref column (direct element or navigation path like author.name)
// to its PII element name, or undefined. `ctx` carries the per-query lookup state.
function _resolvePlainRef(col, ctx) {
  const { model, annotatedByAlias, primaryEntity, forLlm } = ctx
  const ref = col.ref
  const element = ref[ref.length - 1]

  // Unqualified column (e.g. bare `name`): binds to whichever source has the element.
  // Valid CQL even with multiple sources — check every source's annotated set.
  if (ref.length === 1) {
    for (const annotated of annotatedByAlias.values()) {
      if (annotated.has(element)) return col.as ?? element
    }
    return undefined
  }

  // Qualified: ref[0] is a table alias, or an association path on the primary source.
  let annotated = annotatedByAlias.get(ref[0])
  if (!annotated && primaryEntity) {
    let entityDef = primaryEntity
    for (let i = 0; i < ref.length - 1 && entityDef; i++) {
      const assocEl = entityDef.elements?.[ref[i]]
      entityDef = assocEl?.target ? model.definitions?.[assocEl.target] : undefined
    }
    if (entityDef) annotated = personalDataElements(entityDef, forLlm)
  }
  return annotated?.has(element) ? (col.as ?? element) : undefined
}

// Resolve the target entity def reached by walking a ref path from the sources.
// Unqualified expand root (author { ... }) binds to the primary source.
function _resolveExpandTarget(col, ctx) {
  const { model, sources, primaryEntity } = ctx
  const firstSeg = col.ref.length > 1 ? col.ref[0] : null
  let targetDef =
    firstSeg !== null ? (sources.get(firstSeg)?.entityDef ?? primaryEntity) : primaryEntity
  for (const seg of col.ref) {
    const assocEl = targetDef?.elements?.[seg]
    targetDef = assocEl?.target ? model.definitions?.[assocEl.target] : undefined
  }
  return targetDef
}

function _discoverFromCqn(model, srv, cqn, forLlm) {
  // Top-level SET: union results from every branch.
  if (cqn.SET) {
    const all = new Set()
    for (const branch of cqn.SET.args ?? [])
      for (const f of _discoverFromCqn(model, srv, branch, forLlm)) all.add(f)
    return all
  }

  const from = cqn.SELECT?.from
  const columns = cqn.SELECT?.columns

  // SET in FROM (SELECT name FROM (Books UNION Authors)): union branch results,
  // then map through outer columns by their output name (no rename at union level).
  if (from?.SET) {
    const innerPii = new Set()
    for (const branch of from.SET.args ?? [])
      for (const f of _discoverFromCqn(model, srv, branch, forLlm)) innerPii.add(f)
    return _mapThroughColumns(columns, innerPii, false)
  }

  // Subquery FROM: recurse into the inner SELECT, then map through outer columns
  // by the inner (renamed) field name.
  if (from?.SELECT) {
    const innerPii = _discoverFromCqn(model, srv, from, forLlm)
    if (innerPii.size) return _mapThroughColumns(columns, innerPii, true)
  }

  const sources = _collectSources(model, srv, from)
  const primaryEntity = sources.get(null)?.entityDef
  const annotatedByAlias = new Map()
  for (const [alias, { entityDef }] of sources) {
    if (alias === null) continue // primary is also stored under its real alias
    annotatedByAlias.set(alias, personalDataElements(entityDef, forLlm))
  }

  const anyAnnotated = [...annotatedByAlias.values()].some((s) => s.size)
  const hasNavigationOrExpr =
    columns &&
    columns.some((c) => {
      if (!c || typeof c !== "object") return false
      return (
        (Array.isArray(c?.ref) && (c.ref.length > 1 || c.expand)) || c.xpr || c.func || c.SELECT
      )
    })
  if (!anyAnnotated && !hasNavigationOrExpr) return new Set()

  // SELECT * — every source's annotated elements under their plain names.
  if (!columns || columns.some((c) => c === "*")) {
    const all = new Set()
    for (const s of annotatedByAlias.values()) for (const n of s) all.add(n)
    return all
  }

  const ctx = { model, srv, forLlm, sources, annotatedByAlias, primaryEntity }

  const resultNames = new Set()
  for (const col of columns) {
    if (col.expand && col.ref?.length) {
      // Expand: SELECT author { name } — emits path arrays e.g. ["author","name"]
      const assocPath = col.as ? [col.as] : [...col.ref]
      _expandPiiPaths(
        model,
        srv,
        _resolveExpandTarget(col, ctx),
        col.expand,
        assocPath,
        forLlm,
        resultNames,
      )
    } else if (col.ref?.length) {
      // Plain ref: direct element or nav-path
      const name = _resolvePlainRef(col, ctx)
      if (name) resultNames.add(name)
    } else if (col.SELECT && col.as) {
      // Scalar subselect as column
      if (_discoverFromCqn(model, srv, col, forLlm).size > 0) resultNames.add(col.as)
    } else if ((col.xpr || col.func) && col.as) {
      // Expression / function: check extracted refs, then nested subselects
      const byRef = _extractRefs(col).some((ref) =>
        _isRefPii(ref, annotatedByAlias, primaryEntity, model),
      )
      const bySub =
        !byRef &&
        _extractSubselects(col).some((sub) => _discoverFromCqn(model, srv, sub, forLlm).size > 0)
      if (byRef || bySub) resultNames.add(col.as)
    }
  }
  return resultNames
}
