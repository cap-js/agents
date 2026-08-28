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
  // TODO: Not using @Core.SchemaVersion
  const experimentId = creds.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID || "0"

  const data = await _mlflowFetch("/api/2.0/mlflow/runs/create", {
    experiment_id: experimentId,
    run_name: name || `eval-${new Date().toISOString()}`,
    start_time: Date.now(),
    tags: [{ key: "mlflow.source.type", value: "LOCAL" }],
  })
  return data?.run?.info?.run_id ?? null
}

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

export async function postMlflowAssessment(traceId, score, rationale, assessmentName, judgeModel) {
  if (!cds.env.agents?.mlflow) return
  const name = assessmentName
  const assessment = {
    trace_id: traceId,
    assessment_name: name,
    source: { source_type: "LLM_JUDGE", source_id: judgeModel },
    feedback: { value: score },
    rationale: String(rationale),
  }
  let url = `/api/3.0/mlflow/traces/tr-${traceId}/assessments`
  let body = {
    assessment,
  }

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
