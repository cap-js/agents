import {
  postMlflowAssessment,
  createEvalRun,
  closeEvalRun,
  logMlflowMetrics,
} from "../telemetry/mlflow/evaluation.js"
import { flushMlflowTraces } from "../telemetry/mlflow/tracing.js"

export const _evalRunState = {
  runId: null,
  scores: [],
  // contextId → first traceId for conversation-level assessments (MLflow multi-turn)
  conversationTraces: new Map(),
}

// Symbol accumulates per-result pass/fail from judge.evaluate() + assertToolCall().
// postMetrics() reads it to compute success_rate + output_correctness.
export const VALIDATIONS = Symbol.for("@cap-js/agents:eval:validations")

export function evalRun(opts = {}) {
  if (typeof beforeAll !== "function" || typeof afterAll !== "function") return

  beforeAll(async () => {
    _evalRunState.scores.length = 0
    _evalRunState.conversationTraces.clear()
    _evalRunState.runId = await createEvalRun(opts).catch(() => null)
  })

  afterAll(async () => {
    await flushMlflowTraces()
    await closeEvalRun(_evalRunState.runId).catch(() => {})
    _evalRunState.runId = null
    _evalRunState.scores.length = 0
    _evalRunState.conversationTraces.clear()
  })
}

/** Push a pass/fail into the per-result validation accumulator for rollup. */
export function recordValidation(result, pass) {
  if (!result) return
  if (!result[VALIDATIONS]) result[VALIDATIONS] = []
  result[VALIDATIONS].push(pass)
}

/**
 * Post an assessment to MLflow.
 * When result._conversationTraceId differs from result.traceId (multi-turn),
 * also posts a conversation-level assessment on the first trace in the session.
 */
export async function recordScore(score, comment, config) {
  if (score != null) {
    _evalRunState.scores.push(typeof score === "boolean" ? (score ? 1 : 0) : score)
  }
  const traceId = config.traceId
  if (!traceId) return

  await flushMlflowTraces()
  await postMlflowAssessment(traceId, score, comment ?? "", config.assessmentName, config.model)

  // Conversation-level: post assessment on first trace when in a multi-turn session
  const convTraceId = config.conversationTraceId
  if (convTraceId && convTraceId !== traceId) {
    await postMlflowAssessment(
      convTraceId, score, comment ?? "",
      `conversation.${config.assessmentName}`,
      config.model,
    )
  }
}

/** Called by ask.js ootb — posts run metrics + validation rollup to MLflow. */
export async function logMlflowMetricsForResult(result) {
  const metrics = { ...result.metrics }

  const validations = result[VALIDATIONS]
  if (validations?.length) {
    metrics.success_rate = validations.every(Boolean) ? 1 : 0
    metrics.output_correctness = validations.filter(Boolean).length / validations.length
  }

  const runId = _evalRunState.runId
  if (runId) {
    await logMlflowMetrics(runId, metrics).catch(() => {})
  }
}
