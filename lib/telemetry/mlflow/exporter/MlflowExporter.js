import cds from "@sap/cds"

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
      tags: [
        { key: "mlflow.source.name", value: "https://github.com/cap-js/agents/pulls" },
        { key: "mlflow.source.type", value: "LOCAL" },
        { key: "mlflow.user", value: "@cap-js/agents evaluation" },
      ],
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

  async getMetricHistory(runId, key) {
    const metrics = []
    let pageToken
    do {
      const query = new URLSearchParams({
        run_id: runId,
        metric_key: key,
        max_results: 1000,
        ...(pageToken && { page_token: pageToken }),
      }).toString()
      const data = await this._fetch(
        `/api/2.0/mlflow/metrics/get-history?${query}`,
        undefined,
        "GET",
      )
      metrics.push(...(data?.metrics ?? []))
      pageToken = data?.next_page_token
    } while (pageToken)
    return metrics
  }

  async logMetric(runId, key, value, { step = 0 } = {}) {
    await this._fetch("/api/2.0/mlflow/runs/log-metric", {
      run_id: runId,
      key,
      value,
      timestamp: Date.now(),
      step,
    })
  }

  async logParam(runId, key, value) {
    await this._fetch("/api/2.0/mlflow/runs/log-parameter", {
      run_id: runId,
      key,
      value: String(value),
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

  // Returns { tags: [{key,value}], latestVersion: {version, tags} | null }.
  async ensurePrompt(name, description, registrationTags = []) {
    let res = await this._fetch(
      `/api/2.0/mlflow/registered-models/get?name=${encodeURIComponent(name)}`,
      undefined,
      "GET",
    )
    if (!res) {
      res = await this._fetch("/api/2.0/mlflow/registered-models/create", {
        name,
        description,
        tags: registrationTags,
      })
    }
    const rm = res?.registered_model
    const lv = rm?.latest_versions?.[0]
    return {
      tags: rm?.tags ?? [],
      latestVersion: lv ? { version: String(lv.version), tags: lv.tags ?? [] } : null,
    }
  }

  async createPromptVersion(name, description, tags = [], _template = "") {
    const res = await this._fetch("/api/2.0/mlflow/model-versions/create", {
      name,
      source: "dummy-source", // required by API but unused for prompts
      description,
      tags,
    })
    return res?.model_version?.version ? String(res.model_version.version) : null
  }

  async setRegisteredModelTag(name, key, value) {
    await this._fetch("/api/2.0/mlflow/registered-models/set-tag", { name, key, value })
  }
}
