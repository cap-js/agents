import cds from '@sap/cds'

// ── CQL guard ─────────────────────────────────────────────────────────
// A schema-aware lint that runs before a SELECT executes. Instead of teaching
// every domain pitfall in AGENT.md and hoping a small model remembers, we
// detect the mistake against the live cds.model and throw a precise, corrective
// message. The framework turns a thrown tool error into a tool_result the model
// sees, so the agent self-corrects in the same loop — the correction costs
// tokens only on the turn it is actually needed.
//
// General by construction: the rule keys off the schema ("does this entity
// carry a per-row currency?"), never off a specific entity or task, so the same
// guard protects any monetary entity. The one piece of domain *data* it needs is
// the reference exchange rates — in a real app these come from a rates table or
// FX service; here they live in RATES below. The point of the guard is that the
// rates live in exactly ONE place the app owns, and the model never invents them.

const NUMERIC = new Set([
  'cds.Decimal', 'cds.DecimalFloat', 'cds.Double', 'cds.Integer',
  'cds.Integer64', 'cds.UInt8', 'cds.Number',
])

// Aggregates whose result is meaningless when summed/ranked across currencies.
const RANKING_FUNC = /^(SUM|AVG|MIN|MAX|TOTAL)$/i

// Canonical reference rates (→ EUR). The single source of truth for conversion:
// a query that ranks money must normalize using exactly these, and the guard
// hands them back when the model gets them wrong. In production, load these from
// the app's currency-conversion source instead of hard-coding them.
const RATES = { EUR: 1.0, USD: 0.92, SGD: 0.68, JPY: 0.0062 }

// The fix handed back whenever money is ranked/summed without a correct
// conversion. It spells out the exact expression so the model never has to know
// or guess a rate.
const CURRENCY_FIX = [
  'Rank on a converted amount, not the raw one. Convert every currency to EUR',
  'inside the query using exactly these reference rates and cover every currency:',
  '  ROUND(TotalPrice * CASE Currency.code',
  ...Object.entries(RATES).map(([c, r]) => `    WHEN '${c}' THEN ${r}`),
  '    ELSE 1.0 END) AS PriceEUR',
  '  ... ORDER BY PriceEUR DESC',
  'Keep TotalPrice and Currency.code in the SELECT so the real booked amount still shows.',
  'These rates are reference values for ranking, not billing.',
].join('\n')

// Throws cds.error with a corrective message when a SELECT ranks or aggregates a
// monetary amount without a correct currency conversion. Parse errors are left
// alone — the parser reports those on its own.
export function lintCql(cql) {
  if (typeof cql !== 'string' || !cql.trim()) return
  let cqn
  try { cqn = cds.parse.cql(cql) } catch { return }
  const sel = cqn?.SELECT
  if (!sel) return
  const entity = entityDef(sel.from)
  if (!entity || !hasPerRowCurrency(entity)) return

  // Grouping by the currency puts every row of a group in the same currency, so
  // a raw SUM/MIN/MAX within that group is meaningful — a legitimate per-currency
  // breakdown, not a cross-currency mistake. Leave those queries alone.
  if (groupsByCurrency(sel, entity)) return

  // Every expression this query ranks or aggregates by. A monetary amount may
  // only appear here wrapped in a correct EUR conversion.
  for (const node of rankingNodes(sel)) {
    const expr = resolveAlias(node, sel, entity)
    const flat = flatten(expr)
    if (!refsMoney(flat, entity)) continue          // not ranking money — fine
    if (isValidConversion(flat)) continue           // correctly normalized — fine
    cds.error`This query ranks or sums a raw monetary amount, but ${short(entity.name)} rows use different currencies (each row has its own Currency). A large JPY figure is not a large amount, so ordering or adding amounts before converting them is wrong. ${CURRENCY_FIX}`
  }
}

// The entity a SELECT reads from, resolved against the live model.
function entityDef(from) {
  const ref = from?.ref?.[0]
  const name = typeof ref === 'string' ? ref : ref?.id
  return name ? cds.model.definitions[name] ?? null : null
}

// True when the entity has an association to a Currencies code list — i.e. each
// row's amount is denominated in its own currency.
function hasPerRowCurrency(entity) {
  return Object.values(entity.elements ?? {}).some(e =>
    e.type === 'cds.Association' && /(^|\.)Currencies$/.test(e.target ?? ''))
}

// The names of the entity's currency association(s), e.g. "Currency".
function currencyAssocs(entity) {
  return Object.entries(entity.elements ?? {})
    .filter(([, e]) => e.type === 'cds.Association' && /(^|\.)Currencies$/.test(e.target ?? ''))
    .map(([name]) => name)
}

// True when the query groups by the currency (Currency.code, Currency_code, or
// the association itself) — each group is then a single currency.
function groupsByCurrency(sel, entity) {
  const assocs = currencyAssocs(entity)
  return (sel.groupBy ?? []).some(g => {
    const head = g.ref?.[0]
    return assocs.some(a => head === a || head === `${a}_code`)
  })
}

// The expressions a query orders or aggregates by: every ORDER BY term plus the
// argument of every ranking aggregate (SUM/AVG/MIN/MAX/TOTAL).
function rankingNodes(sel) {
  const nodes = []
  for (const o of sel.orderBy ?? []) nodes.push(o)
  for (const c of sel.columns ?? []) {
    if (c.func && RANKING_FUNC.test(c.func)) for (const a of c.args ?? []) nodes.push(a)
  }
  return nodes
}

// A bare `ORDER BY <alias>` points at a SELECT column — follow it to the
// expression that actually computed the value, so a conversion hidden in the
// column list is still inspected. Real element refs and expressions pass through.
function resolveAlias(node, sel, entity) {
  if (!node?.ref || node.ref.length !== 1) return node
  const name = node.ref[0]
  if (entity.elements?.[name]) return node   // a real column (e.g. raw TotalPrice)
  return (sel.columns ?? []).find(c => (c.as ?? c.ref?.[c.ref.length - 1]) === name) ?? node
}

// Flatten a CQN expression into an ordered token stream (strings like 'case' /
// 'when' plus {ref}/{val} leaves), descending through nested xpr and function
// args. Order is preserved so CASE branches can be read off in sequence.
function flatten(node) {
  const out = []
  visit(node)
  return out
  function visit(n) {
    if (n == null) return
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (typeof n !== 'object') { out.push(n); return }
    if (n.xpr) return visit(n.xpr)
    if (n.args) return visit(n.args)
    out.push(n)   // {ref} or {val}
  }
}

// Does the expression reference a raw monetary amount of the entity — a
// non-key numeric element (the amount columns; the currency itself is an assoc)?
function refsMoney(flat, entity) {
  return flat.some(t => {
    if (!t || typeof t !== 'object' || t.ref?.length !== 1) return false
    const el = entity.elements?.[t.ref[0]]
    return el && !el.key && isNumeric(el)
  })
}

// A conversion is valid only if it maps every canonical currency to its exact
// reference rate. A missing currency (falls through to ELSE) or a wrong rate
// corrupts the ranking, so both are rejected. `TotalPrice * 1.0` extracts no
// rates at all → rejected. The correct canonical CASE → accepted.
function isValidConversion(flat) {
  const rates = caseRates(flat)
  if (!rates) return false
  return Object.entries(RATES).every(([code, rate]) => close(rates.get(code), rate))
}

// Read the WHEN '<code>' THEN <rate> pairs out of a CASE, handling both the
// simple form (CASE Currency.code WHEN 'EUR' THEN 1.0 …) and the searched form
// (CASE WHEN Currency.code = 'EUR' THEN 1.0 …). Returns null when there is no CASE.
function caseRates(flat) {
  if (!flat.includes('case')) return null
  const rates = new Map()
  let code = null
  for (let i = flat.indexOf('case'); i < flat.length; i++) {
    const t = flat[i]
    if (t === 'end') break
    if (t === 'when') code = null
    else if (isCodeVal(t)) code = t.val.toUpperCase()
    else if (t === 'then') {
      const rate = rateOf(flat[i + 1])
      if (code != null && rate != null) rates.set(code, rate)
    }
  }
  return rates.size ? rates : null
}

const isCodeVal = t => t && typeof t === 'object' && typeof t.val === 'string' && Number.isNaN(Number(t.val))
const rateOf = t => {
  if (!t || typeof t !== 'object' || t.val == null) return null
  const n = Number(t.val)
  return Number.isNaN(n) ? null : n
}
const close = (a, b) => a != null && Math.abs(a - b) < 1e-6

// Resolve a (possibly custom) type down to its cds.* base and test if numeric.
function isNumeric(el) {
  let t = el.type
  const seen = new Set()
  while (t && !t.startsWith('cds.') && !seen.has(t)) { seen.add(t); t = cds.model.definitions[t]?.type }
  return NUMERIC.has(t)
}

const short = name => String(name).split('.').pop()
