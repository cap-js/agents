import cds from "@sap/cds"
import {
  postMlflowAssessment,
  createEvalRun,
  closeEvalRun,
  logMlflowMetrics,
} from "../telemetry/mlflow/evaluation.js"
import { flushMlflowTraces } from "../telemetry/mlflow/tracing.js"

// The active eval run state is stored on the cds singleton — a stable object
// shared across all module instances and every async context (survives cds._with,
// cds.spawn, ALS boundaries). ALS was unreliable because ask() crosses into CAP's
// own AsyncLocalStorage during execution.
function _makeState(runId, mlflowRunId) {
  return {
    runId,
    mlflowRunId,
    conversationTraces: new Map(),
    validationsByTask: new Map(),
  }
}

/** Returns the active eval run state, or null outside any evalRun. */
export function getActiveRunState() {
  return cds._activeEvalRun ?? null
}

export function evalRun(opts = {}) {
  if (typeof beforeAll !== "function" || typeof afterAll !== "function") return

  let state = null

  beforeAll(async () => {
    const runId = cds.utils.uuid()
    const mlflowRunId = await createEvalRun(opts).catch(() => null)
    state = _makeState(runId, mlflowRunId)
    cds._activeEvalRun = state
  })

  if (typeof afterEach === "function") {
    afterEach(async () => {
      if (state) await _flushValidations(state)
    })
  }

  afterAll(async () => {
    if (state) await _flushValidations(state)
    await flushMlflowTraces()
    await closeEvalRun(state?.mlflowRunId).catch(() => {})
    if (cds._activeEvalRun === state) cds._activeEvalRun = null
    state = null
  })
}

export function recordValidation(result, pass) {
  // Prefer state stamped on the result by ask(); fall back to the cds singleton.
  const state = cds._activeEvalRun
  if (!state || !result?.taskId) return
  const key = result.taskId
  if (!state.validationsByTask.has(key)) {
    state.validationsByTask.set(key, {
      passes: [],
      traceId: result.traceId,
      conversationTraceId: result._conversationTraceId,
    })
  }
  state.validationsByTask.get(key).passes.push(pass)
}

async function _flushValidations(state) {
  if (!state?.validationsByTask.size) return

  for (const [, entry] of state.validationsByTask) {
    const { passes, traceId, conversationTraceId } = entry
    if (!passes.length) continue

    const success_rate = passes.every(Boolean) ? 1 : 0
    const output_correctness = passes.filter(Boolean).length / passes.length

    if (state.mlflowRunId) {
      await logMlflowMetrics(state.mlflowRunId, { success_rate, output_correctness }).catch(
        () => {},
      )
    }

    if (traceId) {
      await flushMlflowTraces()
      await postMlflowAssessment(traceId, success_rate, "", "success_rate").catch(() => {})
      await postMlflowAssessment(traceId, output_correctness, "", "output_correctness").catch(
        () => {},
      )
    }

    if (conversationTraceId && conversationTraceId !== traceId) {
      await postMlflowAssessment(
        conversationTraceId,
        success_rate,
        "",
        "conversation.success_rate",
      ).catch(() => {})
    }
  }
  state.validationsByTask.clear()
}

export async function recordScore(score, comment, config) {
  const traceId = config.traceId
  if (!traceId) return

  await flushMlflowTraces()
  await postMlflowAssessment(traceId, score, comment ?? "", config.assessmentName, config.model)

  const convTraceId = config.conversationTraceId
  if (convTraceId && convTraceId !== traceId) {
    await postMlflowAssessment(
      convTraceId,
      score,
      comment ?? "",
      `conversation.${config.assessmentName}`,
      config.model,
    )
  }
}

export async function logMlflowMetricsForResult(result, state = null) {
  state = state ?? cds._activeEvalRun
  if (!state?.mlflowRunId) return
  await logMlflowMetrics(state.mlflowRunId, result.metrics).catch(() => {})
}
