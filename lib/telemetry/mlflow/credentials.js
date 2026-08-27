import cds from "@sap/cds"

/**
 * Shared credential resolution
 * Config key: cds.env.requires["mlflow"].credentials
 * Required:   MLFLOW_HOST  (or MLFLOW_OTLP_ENDPOINT for tracing)
 * Auth:       OAuth (clientid + clientsecret + url) takes precedence over MLFLOW_TOKEN.
 *             Local MLflow (no auth): both may be absent.
 * Optional UC (Databricks only): UC_CATALOG + UC_SCHEMA + UC_TABLE_PREFIX
 */

/** @returns {{ host: string, uc: {catalog,schema,tablePrefix}|null, warehouseId: string|undefined, getAuthHeaders: () => Promise<Record<string,string>> } | null} */
export function resolveMlflowCredentials() {
  const creds = cds.env.requires?.mlflow?.credentials || {}
  const host = (creds.MLFLOW_HOST || "").replace(/\/$/, "")
  if (!host) return null

  const ucCatalog = creds.UC_CATALOG
  const ucSchema = creds.UC_SCHEMA
  const ucTablePrefix = creds.UC_TABLE_PREFIX
  const uc =
    ucCatalog && ucSchema && ucTablePrefix
      ? { catalog: ucCatalog, schema: ucSchema, tablePrefix: ucTablePrefix }
      : null

  const warehouseId = creds.DATABRICKS_SQL_WAREHOUSE_ID || undefined

  const getAuthHeaders = _buildAuthHeaderFactory(creds)

  return { host, uc, warehouseId, getAuthHeaders }
}

/**
 * Build an async factory that returns { Authorization: "Bearer ..." } headers.
 * OAuth tokens are cached and refreshed 60 s before expiry.
 * Returns an empty object factory when no auth is configured (local MLflow).
 */
function _buildAuthHeaderFactory(creds) {
  if (creds.clientid && creds.clientsecret) {
    const tokenUrl = `${(creds.url || creds.MLFLOW_HOST || "").replace(/\/$/, "")}/oidc/v1/token`
    let cached = null
    let expiresAt = 0
    return async function fetchOAuthHeaders() {
      if (cached && Date.now() < expiresAt) return cached
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${creds.clientid}:${creds.clientsecret}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials&scope=all-apis",
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(
          `MLflow OAuth token fetch failed: HTTP ${res.status} — ${body.slice(0, 200)}`,
        )
      }
      const { access_token, expires_in } = await res.json()
      cached = { Authorization: `Bearer ${access_token}` }
      expiresAt = Date.now() + (expires_in - 60) * 1000
      return cached
    }
  }

  if (creds.MLFLOW_TOKEN) {
    const headers = { Authorization: `Bearer ${creds.MLFLOW_TOKEN}` }
    return async () => headers
  }

  // Local / unauthenticated MLflow
  return async () => ({})
}
