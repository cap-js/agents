import cds from "@sap/cds"
import { resolveMlflowCredentials } from "./credentials.js"

const LOG = cds.log("agents")

// ─── Shared fetch helper ─────────────────────────────────────────────────────

async function _mlflowFetch(path, body, method = "POST") {
  const creds = resolveMlflowCredentials()
  if (!creds) return null
  const { host, getAuthHeaders } = creds
  const authHeaders = await getAuthHeaders()
  const res = await fetch(`${host}${path}`, {
    method,
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    LOG.warn(`[eval] MLflow ${path} failed: ${res.status} ${text.slice(0, 200)}`)
    return null
  }
  return res.json().catch(() => null)
}

export async function createEvalRun({ name } = {}) {
  if (!cds.env.agents?.mlflow) return null

  const creds = cds.env.requires?.mlflow?.credentials || {}
  const experimentId = creds.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID || "0"

  const data = await _mlflowFetch("/api/2.0/mlflow/runs/create", {
    experiment_id: experimentId,
    run_name: name || `eval-${new Date().toISOString()}`,
    start_time: Date.now(),
    tags: [{ key: "mlflow.source.type", value: "LOCAL" }],
  })
  return data?.run?.info?.run_id ?? null
}

export async function closeEvalRun(runId) {
  if (!runId) return

  await _mlflowFetch("/api/2.0/mlflow/runs/update", {
    run_id: runId,
    status: "FINISHED",
    end_time: Date.now(),
  })
}

/**
 * Log a flat metrics object to an MLflow run.
 * Each key becomes a metric; null/undefined values are skipped.
 * @param {string} runId
 * @param {Record<string, number|null>} metrics
 */
export async function logMlflowMetrics(runId, metrics) {
  if (!runId || !cds.env.agents?.mlflow) return
  const ts = Date.now()
  await Promise.allSettled(
    Object.entries(metrics)
      .filter(([, v]) => v != null)
      .map(([key, value]) =>
        _mlflowFetch("/api/2.0/mlflow/runs/log-metric", {
          run_id: runId,
          key,
          value,
          timestamp: ts,
          step: 0,
        }),
      ),
  )
}

export async function postMlflowAssessment(
  traceId,
  score,
  rationale,
  assessmentName,
  sourceId,
  { metadata, sourceType } = {},
) {
  if (!cds.env.agents?.mlflow) return
  const assessment = {
    trace_id: traceId,
    assessment_name: assessmentName,
    source: { source_type: sourceType ?? "LLM_JUDGE", source_id: sourceId ?? null },
    feedback: { value: score },
    rationale: String(rationale),
    ...(metadata && { metadata }),
  }
  let url = `/api/3.0/mlflow/traces/tr-${traceId}/assessments`
  let body = { assessment }

  const { uc, warehouseId } = resolveMlflowCredentials()
  if (uc) {
    const ucTablePrefixFull = `${uc.catalog}.${uc.schema}.${uc.tablePrefix}`
    url = `/api/4.0/mlflow/traces/${encodeURIComponent(ucTablePrefixFull)}/tr-${traceId}/assessments`
    if (warehouseId) url += `?sql_warehouse_id=${encodeURIComponent(warehouseId)}`
    body = Object.assign(assessment, {
      trace_location: {
        type: "UC_TABLE_PREFIX",
        uc_table_prefix: {
          catalog_name: uc.catalog,
          schema_name: uc.schema,
          table_prefix: uc.tablePrefix,
        },
      },
    })
  }

  try {
    const res = await _mlflowFetch(url, body)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      LOG.error(`[eval] MLflow assessment POST failed: ${res.status} ${text.slice(0, 200)}`)
    }
  } catch (err) {
    LOG.error(`[eval] MLflow assessment POST error: ${err.message}`)
  }
}
