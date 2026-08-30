/* global beforeAll, afterEach, afterAll */
import cds from "@sap/cds"
import {
  postMlflowAssessment,
  createEvalRun,
  closeEvalRun,
  logMlflowMetrics,
} from "../telemetry/mlflow/evaluation.js"
import { flushMlflowTraces } from "../telemetry/mlflow/tracing.js"

function _makeState(runId, mlflowRunId) {
  return {
    runId,
    mlflowRunId,
    validationsByTask: new Map(),
  }
}

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
  const state = result?._evalState ?? cds._activeEvalRun
  if (!state || !result?.taskId) return
  const key = result.taskId
  if (!state.validationsByTask.has(key)) {
    state.validationsByTask.set(key, { passes: [], traceId: result.traceId })
  }
  state.validationsByTask.get(key).passes.push(pass)
}

async function _flushValidations(state) {
  if (!state?.validationsByTask.size) return

  const tasks = []
  for (const [, entry] of state.validationsByTask) {
    const { passes, traceId } = entry
    if (!passes.length) continue

    const success_rate = passes.every(Boolean) ? 1 : 0
    const output_correctness = passes.filter(Boolean).length / passes.length
    const codeOpts = { sourceType: "CODE" }

    if (state.mlflowRunId) {
      tasks.push(
        logMlflowMetrics(state.mlflowRunId, { success_rate, output_correctness }).catch(() => {}),
      )
    }

    if (traceId) {
      tasks.push(
        flushMlflowTraces().then(() =>
          Promise.all([
            postMlflowAssessment(traceId, success_rate, "", "success_rate", null, codeOpts).catch(
              () => {},
            ),
            postMlflowAssessment(
              traceId,
              output_correctness,
              "",
              "output_correctness",
              null,
              codeOpts,
            ).catch(() => {}),
          ]),
        ),
      )
    }
  }

  await Promise.all(tasks)
  state.validationsByTask.clear()
}

export async function recordScore(score, comment, config) {
  const traceId = config.traceId
  if (!traceId) return

  const opts = { sourceType: config.sourceType }
  await flushMlflowTraces()

  // conversationLevel: ConversationJudge — post with session metadata only
  if (config.conversationLevel) {
    await postMlflowAssessment(
      traceId,
      score,
      comment ?? "",
      config.assessmentName,
      config.model ?? null,
      { ...opts, metadata: { "mlflow.trace.session": config.sessionId ?? "" } },
    )
  } else {
    // Single-turn: post to this trace only, no session metadata
    await postMlflowAssessment(
      traceId,
      score,
      comment ?? "",
      config.assessmentName,
      config.model ?? null,
      opts,
    )
  }
}

export async function logMlflowMetricsForResult(result, state = null) {
  state = state ?? cds._activeEvalRun
  if (!state?.mlflowRunId) return
  await logMlflowMetrics(state.mlflowRunId, result.metrics).catch(() => {})
}
