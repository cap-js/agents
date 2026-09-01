import cds from "@sap/cds"
import { resolveMlflowCredentials } from "../credentials.js"

const LOG = cds.log("agents")

export class MlflowExporter {
  constructor(creds) {
    this._creds = creds
  }

  async _fetch(path, body, method = "POST") {
    const { host, getAuthHeaders } = this._creds
    const headers = { ...(await getAuthHeaders()), "Content-Type": "application/json" }
    try {
      const res = await fetch(`${host}${path}`, { method, headers, body: JSON.stringify(body) })
      if (!res.ok) {
        LOG.error(`[mlflow] ${method} ${path} → ${res.status}: ${(await res.text().catch(() => ""))}`)
        return null
      }
      return res.json().catch(() => null)
    } catch (err) {
      LOG.debug(`[mlflow] ${path} error: ${err.message}`)
      return null
    }
  }

  // ─── Runs ─────────────────────────────────────────────────────────────────

  async createRun(experimentId, name) {
    const data = await this._fetch("/api/2.0/mlflow/runs/create", {
      experiment_id: experimentId,
      run_name: name || `eval-${new Date().toISOString()}`,
      start_time: Date.now(),
      tags: [{ key: "mlflow.source.type", value: "LOCAL" }],
    })
    return data?.run?.info?.run_id ?? null
  }

  async closeRun(runId) {
    await this._fetch("/api/2.0/mlflow/runs/update", {
      run_id: runId,
      status: "FINISHED",
      end_time: Date.now(),
    })
  }

  async logMetric(runId, key, value) {
    await this._fetch("/api/2.0/mlflow/runs/log-metric", {
      run_id: runId,
      key,
      value,
      timestamp: Date.now(),
      step: 0,
    })
  }

  // ─── Assessments ──────────────────────────────────────────────────────────

  async postAssessment(traceId, score, rationale, assessmentName, sourceId, { metadata, sourceType } = {}) {
    const body = {
      assessment: {
        trace_id: traceId,
        assessment_name: assessmentName,
        source: { source_type: sourceType ?? "LLM_JUDGE", source_id: sourceId ?? null },
        feedback: { value: score },
        rationale: String(rationale),
        ...(metadata && { metadata }),
      },
    }
    await this._fetch(`/api/3.0/mlflow/traces/tr-${traceId}/assessments`, body)
  }

  // ─── Prompts ──────────────────────────────────────────────────────────────

  // `registrationTags` — [{key,value}] tags for the registered-model entry (caller-supplied).
  async ensurePrompt(name, description, registrationTags = []) {
    const got = await this._fetch(`/api/2.0/mlflow/registered-models/get?name=${encodeURIComponent(name)}`, undefined, "GET")
    if (got) return
    await this._fetch("/api/2.0/mlflow/registered-models/create", { name, description, tags: registrationTags })
  }

  // Returns { version, tags: [{key,value}] } of the latest version, or null.
  async getLatestPromptVersion(name) {
    const res = await this._fetch("/api/2.0/mlflow/model-versions/search", {
      filter: `name='${name}'`,
      order_by: ["version_number DESC"],
      max_results: 1,
    }, "GET")
    const mv = res?.model_versions?.[0]
    if (!mv) return null
    return { version: String(mv.version), tags: mv.tags ?? [] }
  }

  // `tags` — [{key,value}] assembled by the caller. `template` used by UC subclass.
  async createPromptVersion(name, description, tags = [], _template = "") {
    const res = await this._fetch("/api/2.0/mlflow/model-versions/create", {
      name,
      source: "prompt",
      description,
      tags,
    })
    return res?.model_version?.version ? String(res.model_version.version) : null
  }
}
