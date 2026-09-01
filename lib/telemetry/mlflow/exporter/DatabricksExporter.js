import { MlflowExporter } from "./MlflowExporter.js"

export class DatabricksExporter extends MlflowExporter {
  async postAssessment(
    traceId,
    score,
    rationale,
    assessmentName,
    sourceId,
    { metadata, sourceType } = {},
  ) {
    const { uc, warehouseId } = this._creds
    const ucPrefix = `${uc.catalog}.${uc.schema}.${uc.tablePrefix}`
    let url = `/api/4.0/mlflow/traces/${encodeURIComponent(ucPrefix)}/tr-${traceId}/assessments`
    if (warehouseId) url += `?sql_warehouse_id=${encodeURIComponent(warehouseId)}`
    await this._fetch(url, {
      trace_id: traceId,
      assessment_name: assessmentName,
      source: { source_type: sourceType ?? "LLM_JUDGE", source_id: sourceId ?? null },
      feedback: { value: score },
      rationale: String(rationale),
      ...(metadata && { metadata }),
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

  async ensurePrompt(name, description) {
    const got = await this._fetch(
      `/mlflow/unity-catalog/prompts/${encodeURIComponent(name)}`,
      undefined,
      "GET",
    )
    if (got) return
    await this._fetch("/mlflow/unity-catalog/prompts", { name, prompt: { description } })
  }

  // Returns { version, tags } of the latest version, or null.
  async getLatestPromptVersion(name) {
    const res = await this._fetch(
      `/mlflow/unity-catalog/prompts/${encodeURIComponent(name)}/versions/search`,
      { max_results: 1 },
    )
    const pv = res?.prompt_versions?.[0]
    if (!pv) return null
    return { version: String(pv.version), tags: pv.tags ?? [] }
  }

  async createPromptVersion(name, description, tags = [], template = "") {
    const res = await this._fetch(
      `/mlflow/unity-catalog/prompts/${encodeURIComponent(name)}/versions`,
      {
        prompt_version: { template, description, tags },
      },
    )
    return res?.version ? String(res.version) : null
  }

  async setRegisteredModelTag(name, key, value) {
    await this._fetch(`/mlflow/unity-catalog/prompts/${encodeURIComponent(name)}/tags`, {
      key,
      value,
    })
  }

  async getRegisteredModelTag(name, key) {
    const res = await this._fetch(
      `/mlflow/unity-catalog/prompts/${encodeURIComponent(name)}`,
      undefined,
      "GET",
    )
    return res?.tags?.find((t) => t.key === key)?.value ?? null
  }
}
