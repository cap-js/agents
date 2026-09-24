import cds from "@sap/cds"
import { getMlflowExporter } from "./exporter/index.js"

export async function createEvalRun({ name } = {}) {
  const exporter = getMlflowExporter()
  if (!exporter) return null
  const creds = cds.env.requires?.mlflow?.credentials || {}
  const experimentId = creds.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID || "0"
  return exporter.createRun(experimentId, name)
}

export async function closeEvalRun(runId) {
  if (!runId) return
  getMlflowExporter()?.closeRun(runId)
}

// Log a flat metrics object; null/undefined values are skipped.
export async function logMlflowMetrics(runId, metrics) {
  if (!runId) return
  const exporter = getMlflowExporter()
  if (!exporter) return
  await Promise.allSettled(
    Object.entries(metrics)
      .filter(([, v]) => v != null)
      .map(([key, value]) => exporter.logMetric(runId, key, value)),
  )
}

export async function postMlflowAssessment(
  traceId,
  score,
  rationale,
  assessmentName,
  sourceId,
  opts,
) {
  getMlflowExporter()?.postAssessment(traceId, score, rationale, assessmentName, sourceId, opts)
}
