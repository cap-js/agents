import cds from "@sap/cds"

const PERSONAL_DATA_CACHE = Symbol.for("@cap-js/agents:personalDataPaths")

const STRING_TYPES = new Set(["cds.String", "cds.UUID", "cds.LargeString"])
const NUMERIC_TYPES = new Set(["cds.Integer", "cds.Integer64", "cds.Decimal", "cds.Double"])

export const PD_ANNOTATIONS = [
  "@PersonalData.IsPotentiallyPersonal",
  "@PersonalData.IsPotentiallySensitive",
  "@PersonalData.FieldSemantics",
  "@agent.masking",
]

export function shouldHash(el) {
  if (STRING_TYPES.has(el.type)) return true
  if (NUMERIC_TYPES.has(el.type)) return !!(el.key || el["@odata.foreignKey4"])
  return false
}

export function personalDataElements(entityDef, forLlm = true) {
  if (!entityDef?.elements) return new Set()
  const result = new Set()
  for (const [name, el] of Object.entries(entityDef.elements)) {
    if (!shouldHash(el)) continue
    if (!PD_ANNOTATIONS.some(a => el[a] != null && el[a] !== false)) continue
    if (forLlm && el["@agent.masking"] === false) continue
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

// Walk a FROM clause (which may be a nested join tree) and collect every source
// entity keyed by its alias. Joins nest via { join, args: [...] }.
function _collectSources(model, srv, from, out = new Map()) {
  if (!from) return out
  if (Array.isArray(from.args)) {
    for (const arg of from.args) _collectSources(model, srv, arg, out)
    return out
  }
  const src = _resolveSource(model, srv, from)
  if (src) out.set(src.alias, src)
  return out
}

export function queryEntityElements(model, srv, cql, forLlm) {
  if (!cql) return new Set()
  return cache(model, `query:${srv.name}:${cql}:${forLlm}`, () => {
    let cqn
    try {
      cqn = cds.parse.cql(cql)
    } catch { return new Set() }

    const from = cqn.SELECT?.from
    if (!from) return new Set()

    // All source entities (single entity → one; join → many), keyed by alias,
    // each with its own set of personal-data element names.
    const sources = _collectSources(model, srv, from)
    if (!sources.size) return new Set()
    const annotatedByAlias = new Map()
    for (const [alias, { entityDef }] of sources) {
      annotatedByAlias.set(alias, personalDataElements(entityDef, forLlm))
    }
    const anyAnnotated = [...annotatedByAlias.values()].some(s => s.size)
    if (!anyAnnotated) return new Set()

    const columns = cqn.SELECT?.columns
    // SELECT * (or no explicit projection): every source's annotated elements
    // surface under their plain element names. (Single-source is the common
    // case; for a join with '*' the result keys are the element names too.)
    if (!columns || columns.some(c => c === "*")) {
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
    for (const col of columns) {
      const ref = col?.ref
      if (!ref?.length) continue
      const element = ref[ref.length - 1]
      // Qualified ref "alias.element" → use ref[0] as alias; else the sole source.
      const alias = ref.length > 1 ? ref[0] : singleAlias
      const annotated = annotatedByAlias.get(alias)
      if (!annotated?.has(element)) continue
      resultNames.add(col.as ?? element)
    }
    return resultNames
  })
}

export function hasPersonalDataAnnotations(model, serviceName) {
  return cache(model, `hasAny:${serviceName}`, () =>
    Object.entries(model.definitions ?? {}).some(([name, def]) => {
      if (!name.startsWith(serviceName + ".") && name !== serviceName) return false
      if (!def.elements) return false
      return Object.values(def.elements).some(el =>
        PD_ANNOTATIONS.some(a => el[a] != null && el[a] !== false)
      )
    })
  )
}

export function pseudonymizeData(data, annotatedFields, session) {
  if (!annotatedFields.size) return
  const rows = Array.isArray(data) ? data : (data ? [data] : [])
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    for (const field of annotatedFields) {
      if (!(field in row) || row[field] == null) continue
      row[field] = session.pseudonymize(row[field], field)
    }
  }
}

export function resolveArgs(value, session) {
  if (typeof value === "string") return session.resolveText(value)
  if (Array.isArray(value)) return value.map(v => resolveArgs(v, session))
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveArgs(v, session)
    return out
  }
  return value
}
