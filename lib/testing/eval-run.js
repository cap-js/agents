import {
  postMlflowAssessment,
  createEvalRun,
  closeEvalRun,
} from "../telemetry/mlflow/evaluation.js"
import { flushMlflowTraces } from "../telemetry/mlflow/tracing.js"

export const _evalRunState = {
  runId: null,
  scores: [],
}

export function evalRun(opts = {}) {
  if (typeof beforeAll !== "function" || typeof afterAll !== "function") return

  beforeAll(async () => {
    _evalRunState.scores.length = 0
    _evalRunState.runId = await createEvalRun(opts).catch(() => null)
  })

  afterAll(async () => {
    await flushMlflowTraces()
    await closeEvalRun(_evalRunState.runId, { scores: _evalRunState.scores }).catch(() => {})
    _evalRunState.runId = null
    _evalRunState.scores.length = 0
  })
}

export async function recordScore(score, comment, config) {
  if (score != null) _evalRunState.scores.push(score)
  if (config.traceId) {
    await flushMlflowTraces()
    await postMlflowAssessment(
      config.traceId,
      score,
      comment ?? "",
      config.assesmentName,
      config.model,
    )
  }
}
