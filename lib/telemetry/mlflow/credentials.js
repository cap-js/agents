import cds from "@sap/cds"
import { token } from "../../utils/compat.js" // cds11: replace with `const { token } = cds.utils`

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

// Resolution order: @Core.SchemaVersion annotation → credentials → env.
// MLflow experiment IDs must be numeric strings (int64).
export function resolveExperimentId() {
  const srvName = cds.context?.["agent.service"]
  if (srvName) {
    const def = cds.context?.model?.definitions?.[srvName] || cds.services?.[srvName]?.definition
    const annotated = def?.["@Core.SchemaVersion"]
    if (annotated) return String(annotated)
  }
  const creds = cds.env.requires?.mlflow?.credentials || {}
  return creds.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID || null
}

/**
 * Build an async factory that returns { Authorization: "Bearer ..." } headers.
 * OAuth tokens are cached and refreshed 60 s before expiry.
 * Returns an empty object factory when no auth is configured (local MLflow).
 */
function _buildAuthHeaderFactory(creds) {
  if (creds.clientid && creds.clientsecret) {
    const tokenUrl = `${(creds.url || creds.MLFLOW_HOST || "").replace(/\/$/, "")}/oidc/v1/token`
    return async function fetchOAuthHeaders() {
      const endpoint = new URL(tokenUrl)
      const access_token = await token(
        { ...creds, url: endpoint.origin },
        {
          path: endpoint.pathname,
          form: { scope: "all-apis" },
          timeout: 10_000,
        },
      )
      return { Authorization: `Bearer ${access_token}` }
    }
  }

  if (creds.MLFLOW_TOKEN) {
    const headers = { Authorization: `Bearer ${creds.MLFLOW_TOKEN}` }
    return async () => headers
  }

  // Local / unauthenticated MLflow
  return async () => ({})
}
