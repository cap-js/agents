import cds from "@sap/cds"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { getMlflowExporter } from "./exporter/index.js"

const execFileAsync = promisify(execFile)

export async function createEvalRun({ name } = {}) {
  const exporter = getMlflowExporter()
  if (!exporter) return null
  const creds = cds.env.requires?.mlflow?.credentials || {}
  const experimentId = creds.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID || "0"
  const tags = [
    ...(await getSourceTags()),
    { key: "mlflow.user", value: "@cap-js/agents evaluation" },
  ]
  return exporter.createRun(experimentId, name, tags)
}

export async function closeEvalRun(runId, metricKeys = [], prompts = []) {
  if (!runId) return
  const exporter = getMlflowExporter()
  if (!exporter) return
  await logFinalMlflowMetrics(runId, metricKeys, exporter)
  if (prompts.length) await exporter.linkPromptVersionsToRun(runId, prompts).catch(() => {})
  await exporter.closeRun(runId)
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

export async function logMlflowRunMetadata(runId, metadata, exporter = getMlflowExporter()) {
  if (!runId || !exporter || !metadata) return
  const params = {
    ...(metadata.model && { "llm.model": metadata.model }),
    ...(metadata.provider && { "llm.provider": metadata.provider }),
  }
  for (const [key, value] of Object.entries(metadata.params ?? {})) {
    if (value != null) params[`llm.param.${key}`] = _stringifyMlflowValue(value)
  }

  await Promise.allSettled(
    Object.entries(params).map(([key, value]) => exporter.logParam(runId, key, value)),
  )
}

const AVG_METRICS = { success_rate: 1, output_correctness: 1, latency_ms: 1 }

export async function logFinalMlflowMetrics(runId, metricKeys, exporter = getMlflowExporter()) {
  if (!runId || !exporter) return
  const keys = Array.from(metricKeys ?? [])
  await Promise.allSettled(
    keys.map(async (key) => {
      const history = await exporter.getMetricHistory(runId, key)
      const values = history
        .filter((metric) => metric?.step !== 1)
        .map((metric) => Number(metric?.value))
        .filter(Number.isFinite)
      if (!values.length) return

      const total = values.reduce((sum, value) => sum + value, 0)
      const aggregate = AVG_METRICS[key] ? total / values.length : total
      await exporter.logMetric(runId, key, aggregate, { step: 1 })
    }),
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

function _stringifyMlflowValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function isCI() {
  return process.env.GITHUB_ACTIONS === "true"
}

async function getSourceTags() {
  const root = cds.root || process.cwd()
  let packageJson = {}
  try {
    packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  } catch {
    // Source metadata stays optional when project metadata cannot be read.
  }

  const repository =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url
  const sourceName = repository?.replace(/^git\+/, "").replace(/\.git$/, "") || packageJson.name
  const gitValue = (args) =>
    execFileAsync("git", args, { cwd: root })
      .then(({ stdout }) => stdout.trim())
      .catch(() => null)
  const [branch, commit] = await Promise.all([
    gitValue(["branch", "--show-current"]),
    gitValue(["rev-parse", "HEAD"]),
  ])

  return [
    sourceName && { key: "mlflow.source.name", value: sourceName },
    { key: "mlflow.source.type", value: isCI() ? "JOB" : "LOCAL" },
    branch && { key: "mlflow.source.git.branch", value: branch },
    commit && { key: "mlflow.source.git.commit", value: commit },
  ].filter(Boolean)
}
