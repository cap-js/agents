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
      const res = await fetch(`${host}${path}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      if (!res.ok) {
        LOG.error(
          `[mlflow] ${method} ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        )
        return null
      }
      return res.json().catch(() => null)
    } catch (err) {
      LOG.debug(`[mlflow] ${path} error: ${err.message}`)
      return null
    }
  }

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

  async postAssessment(
    traceId,
    score,
    rationale,
    assessmentName,
    sourceId,
    { metadata, sourceType } = {},
  ) {
    await this._fetch(`/api/3.0/mlflow/traces/tr-${traceId}/assessments`, {
      assessment: {
        trace_id: traceId,
        assessment_name: assessmentName,
        source: { source_type: sourceType ?? "LLM_JUDGE", source_id: sourceId ?? null },
        feedback: { value: score },
        rationale: String(rationale),
        ...(metadata && { metadata }),
      },
    })
  }

  async ensurePrompt(name, description, registrationTags = []) {
    let prompt = await this._fetch(
      `/api/2.0/mlflow/registered-models/get?name=${encodeURIComponent(name)}`,
      undefined,
      "GET",
    )
    if (prompt) return prompt.registered_model
    prompt = await this._fetch("/api/2.0/mlflow/registered-models/create", {
      name,
      description,
      tags: registrationTags,
    })
    return prompt.registered_model
  }

  // Returns { version, tags } of the latest version, or null.
  async getLatestPromptVersion(name) {
    const params = new URLSearchParams({
      filter: `name='${name}'`,
      "order_by[]": "version_number DESC",
      max_results: "1",
    })
    const res = await this._fetch(
      `/api/2.0/mlflow/model-versions/search?${params}`,
      undefined,
      "GET",
    )
    const mv = res?.model_versions?.[0]
    if (!mv) return null
    return { version: String(mv.version), tags: mv.tags ?? [] }
  }

  async createPromptVersion(name, description, tags = [], _template = "") {
    const res = await this._fetch("/api/2.0/mlflow/model-versions/create", {
      name,
      source: "dummy-source", // required by API but unused for prompts — mirrors Python SDK
      description,
      tags,
    })
    return res?.model_version?.version ? String(res.model_version.version) : null
  }

  async setRegisteredModelTag(name, key, value) {
    await this._fetch("/api/2.0/mlflow/registered-models/set-tag", { name, key, value })
  }

  // Returns the tag value for `key` on the registered model, or null.
  async getRegisteredModelTag(name, key) {
    const res = await this._fetch(
      `/api/2.0/mlflow/registered-models/get?name=${encodeURIComponent(name)}`,
      undefined,
      "GET",
    )
    return res?.registered_model?.tags?.find((t) => t.key === key)?.value ?? null
  }
}
