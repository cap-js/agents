import cds from "@sap/cds"
import { resolveMlflowCredentials } from "./credentials.js"

const LOG = cds.log("agents")

// ─── Shared fetch helper ─────────────────────────────────────────────────────

async function _mlflowFetch(path, body) {
  const mlflow = resolveMlflowCredentials()
  if (!mlflow) return null
  const { host, getAuthHeaders } = mlflow
  const authHeaders = await getAuthHeaders()
  const res = await fetch(`${host}${path}`, {
    method: "POST",
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

// ─── Run lifecycle ────────────────────────────────────────────────────────────

/**
 * Create an MLflow Run in the experiment configured via @Core.SchemaVersion or
 * MLFLOW_EXPERIMENT_ID. Returns the run_id, or null when MLflow is not configured.
 *
 * Works on both local and Databricks MLflow.
 */
export async function createEvalRun({ name } = {}) {
  if (!cds.env.agents?.mlflow) return null

  const creds = cds.env.requires?.["databricks-mlflow"]?.credentials || {}
  const experimentId =
    creds.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID || "0"

  const data = await _mlflowFetch("/api/2.0/mlflow/runs/create", {
    experiment_id: experimentId,
    run_name: name || `eval-${new Date().toISOString()}`,
    start_time: Date.now(),
    tags: [{ key: "mlflow.source.type", value: "LOCAL" }],
  })
  return data?.run?.info?.run_id ?? null
}

/**
 * Finish an MLflow Run and log aggregated eval metrics.
 * @param {string} runId
 * @param {{ scores: number[] }} stats
 */
export async function closeEvalRun(runId, { scores = [] } = {}) {
  if (!runId) return

  if (scores.length > 0) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length
    await _mlflowFetch("/api/2.0/mlflow/runs/log-metric", {
      run_id: runId,
      key: "eval_score_avg",
      value: avg,
      timestamp: Date.now(),
      step: 0,
    }).catch(() => {})
    await _mlflowFetch("/api/2.0/mlflow/runs/log-metric", {
      run_id: runId,
      key: "eval_count",
      value: scores.length,
      timestamp: Date.now(),
      step: 0,
    }).catch(() => {})
  }

  await _mlflowFetch("/api/2.0/mlflow/runs/update", {
    run_id: runId,
    status: "FINISHED",
    end_time: Date.now(),
  })
}

// ─── Assessment ───────────────────────────────────────────────────────────────

/**
 * POST a judge score as an MLflow assessment on the trace identified by traceId.
 *
 * Two modes (auto-detected from credentials):
 *  - Databricks/UC: POST /api/4.0/mlflow/traces/{ucTablePrefix}/{traceId}/assessments
 *  - Local / open-source MLflow: POST /api/3.0/mlflow/traces/{traceId}/assessments
 *
 * Auth is shared with the OTLP exporter: OAuth (clientid+clientsecret) or
 * static DATABRICKS_TOKEN or unauthenticated (local MLflow).
 * No-op when cds.env.agents.mlflow is falsy or DATABRICKS_HOST is not configured.
 */
export async function postMlflowAssessment(traceId, score, rationale, assessmentName, runId) {
  if (!cds.env.agents?.mlflow) return

  const mlflow = resolveMlflowCredentials()
  if (!mlflow) return

  const { host, uc, warehouseId, getAuthHeaders } = mlflow
  const judgeModel = process.env.EVAL_JUDGE_MODEL || "gpt-4o"
  const name = assessmentName || "judge_score"

  let url, body
  if (uc) {
    const ucTablePrefixFull = `${uc.catalog}.${uc.schema}.${uc.tablePrefix}`
    url = `${host}/api/4.0/mlflow/traces/${encodeURIComponent(ucTablePrefixFull)}/${traceId}/assessments`
    if (warehouseId) url += `?sql_warehouse_id=${encodeURIComponent(warehouseId)}`
    body = {
      assessment_name: name,
      trace_id: traceId,
      trace_location: {
        type: "UC_TABLE_PREFIX",
        uc_table_prefix: { catalog_name: uc.catalog, schema_name: uc.schema, table_prefix: uc.tablePrefix },
      },
      source: { source_type: "LLM_JUDGE", source_id: judgeModel },
      feedback: { value: score },
      rationale: String(rationale).slice(0, 1000),
      ...(runId && { metadata: { run_id: runId } }),
    }
  } else {
    url = `${host}/api/3.0/mlflow/traces/${traceId}/assessments`
    body = {
      assessment: {
        trace_id: traceId,
        name,
        source: { source_type: "LLM_JUDGE", source_id: judgeModel },
        feedback: { value: score },
        rationale: String(rationale).slice(0, 1000),
        ...(runId && { metadata: [{ key: "run_id", value: runId }] }),
      },
    }
  }

  try {
    const authHeaders = await getAuthHeaders()
    const res = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      LOG.warn(`[eval] MLflow assessment POST failed: ${res.status} ${text.slice(0, 200)}`)
    }
  } catch (err) {
    LOG.warn(`[eval] MLflow assessment POST error: ${err.message}`)
  }
}
