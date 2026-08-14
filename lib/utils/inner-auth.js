import cds from "@sap/cds"

/**
 * Dev-only preview auth challenge.
 *
 * When a CDS service has NO service-level `@requires`/`@restrict` but SOME
 * entity or action inside is gated, an anonymous user has no access
 */
export const previewAuthChallenge = (srv) => (req, res, next) => {
  // Auth kind — only mocked participates. `dummy` is intentionally excluded
  // (grants every role to every user — nothing to challenge). Production auth
  // strategies (`xsuaa`, `jwt`, `ias`, ...) are untouched.
  const auth = cds.env.requires?.auth
  const kind = typeof auth === "string" ? auth : auth?.kind
  if (kind !== "mocked") return next()

  // Service shape — service itself must be open (else the outer 401 gate in
  // `lib/index.js` already challenges), but something inside must be gated.
  const def = srv?.definition
  if (!def || def["@requires"] || def["@restrict"]) return next()
  const hasInnerAuth =
    Object.values(srv.entities || {}).some((e) => e["@requires"] || e["@restrict"]) ||
    Array.from(srv.actions || []).some((a) => a["@requires"] || a["@restrict"])
  if (!hasInnerAuth) return next()

  // Caller identity — anonymous callers get the challenge.
  const user = cds.context?.user || req?.user
  const anonymous = !user || user._is_anonymous || user.id === "anonymous"
  if (!anonymous) return next()

  res.setHeader("WWW-Authenticate", `Basic realm="cap-agents:${srv.name}"`)
  res.status(401).end()
}
