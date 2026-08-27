/**
 * Test-time helpers exposed on `cds.test(dir).agents` (via a lazy getter on
 * `Test.prototype` installed by cds-plugin.js).
 *
 * Surface:
 *   - runAgent(service, query, opts?)   — send a query to an @agent CAP
 *                                         service via the A2A protocol.
 *                                         `service` can be either the
 *                                         service name (mapped to
 *                                         `/a2a/<name>/`) or a full path
 *                                         starting with `/` for services
 *                                         with a custom `@path` annotation.
 *                                         Returns `{ text, toolCalls,
 *                                         toolWasCalled, task, raw }`.
 *                                         `opts.mocks: { [toolName]: fn }`
 *                                         mocks tools for this call only,
 *                                         merged on top of suite-wide mocks.
 *   - mockTools(map)                    — merge into suite-wide mocks that
 *                                         apply to every subsequent runAgent.
 *   - clearMocks()                      — clear suite-wide mocks.
 *   - createEvalJudge(opts?)            — LLM-as-judge factory (openevals +
 *                                         SAP AI Core OrchestrationClient).
 *   - evaluate(judge, {…})              — score + log helper (no assertion).
 *
 * `openevals` is an optional peer dependency — importing `createEvalJudge`
 * without it installed throws a clear message.
 *
 * Statelessness: recorded tool-call state and per-invocation mocks live
 * inside a `runAgent` call's closure and are disposed on return. Suite-wide
 * mocks live on the per-instance `test.agents` object; they persist for the
 * lifetime of the `cds.test(...)` instance (typically one test file).
 * Known limitation: multiple `runAgent` calls running concurrently in the
 * SAME Node process will each see the union of tool calls in the overlap
 * window — Vitest's default file-parallel/test-serial execution avoids this.
 */

import cds from "@sap/cds"
import { addScope, ensureToolRecordingPatch } from "./tool-recorder.js"
import {
  postMlflowAssessment,
  createEvalRun,
  closeEvalRun,
} from "../telemetry/mlflow/evaluation.js"
import { flushMlflowTraces } from "../telemetry/mlflow/tracing.js"

// Default: gpt-4o. Anthropic's structured-outputs API recently changed
// (`output_format` → `output_config.format`) and SAP AI Core Orchestration's
// LLM Module has not been updated to match, so `withStructuredOutput` on
// any Claude model via Orchestration currently returns 400. See
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs.
// Override via the `EVAL_JUDGE_MODEL` env var or `createEvalJudge({ model })`
// once the Orchestration LLM Module catches up.
const DEFAULT_JUDGE_MODEL = "gpt-4o"

const DEFAULT_JUDGE_PROMPT = `You are an expert evaluator for an AI assistant.

User question: {inputs}
Actual response: {outputs}

Score 0.0-1.0: does the response fully satisfy the criteria specified in the user question context?
Explain your reasoning, then end with: Thus, the score should be: SCORE_YOU_ASSIGN.`

/** Build the `.agents` helper bag for a single `cds.test(...)` instance. */
export function buildAgentsHelpers(testCtx) {
  // Kick off the (idempotent) prototype patch. No scopes are attached here —
  // each `runAgent` registers its own scope with its own recorder + mocks.
  ensureToolRecordingPatch().catch(() => {
    /* langchain not present — runAgent's toolCalls will just stay empty */
  })

  // Suite-wide mocks, mutable via mockTools/clearMocks. Merged into every
  // runAgent call's effective mock map (per-invocation `opts.mocks` overrides
  // matching keys).
  const suiteMocks = {}

  // Active MLflow Run state — set by evalRun(), consumed by evaluate().
  let _runId = null
  const _scores = []

  return { runAgent, createEvalJudge, evaluate, evalRun, mockTools, clearMocks }

  // ────────────────────────────────────────────────────────────────────────
  // Eval run (MLflow Run lifecycle)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Register beforeAll/afterAll hooks that open and close an MLflow Run for
   * the current test suite. Returns the helpers bag so the call is chainable:
   *
   *   const { runAgent, evaluate, createEvalJudge } = cds.test(dir).agents.evalRun()
   *   const { runAgent, evaluate, createEvalJudge } = cds.test(dir).agents.evalRun({ name: "my-eval" })
   *
   * beforeAll: creates an MLflow Run (no-op when MLflow is not configured).
   * afterAll:  logs aggregate score metrics and closes the Run.
   *
   * `evaluate()` automatically records each score into the run and links
   * the assessment to the run via metadata.
   */
  function evalRun(opts = {}) {
    beforeAll(async () => {
      _scores.length = 0
      _runId = await createEvalRun(opts).catch(() => null)
    })
    afterAll(async () => {
      await flushMlflowTraces()
      await closeEvalRun(_runId, { scores: _scores }).catch(() => {})
      _runId = null
      _scores.length = 0
    })
    return { runAgent, createEvalJudge, evaluate, evalRun, mockTools, clearMocks }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Mocking
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Merge a `{ [toolName]: async (args) => result }` map into suite-wide
   * mocks. Applies to every subsequent `runAgent` call. Later calls override
   * earlier calls for matching keys.
   *
   *   beforeAll(() => test.agents.mockTools({ getStock: async () => 999 }))
   */
  function mockTools(map) {
    if (map && typeof map === "object") Object.assign(suiteMocks, map)
  }

  /** Clear all suite-wide mocks. Typically called in `afterAll`. */
  function clearMocks() {
    for (const k of Object.keys(suiteMocks)) delete suiteMocks[k]
  }

  // ────────────────────────────────────────────────────────────────────────
  // A2A driver
  // ────────────────────────────────────────────────────────────────────────

  async function runAgent(service, query, opts = {}) {
    // Await the (idempotent) prototype patch BEFORE the HTTP call so that any
    // MCP tools created during the ensuing graph build see our patched
    // invoke — mcp-tools.js captures `tool.invoke.bind(tool)` at instance
    // wrap time, which must resolve to our patch, not the raw prototype method.
    await ensureToolRecordingPatch()

    const axios = testCtx.axios
    if (!axios) throw new Error("cds.test(...).agents.runAgent: no axios on test context")

    const toolCalls = []
    // Per-invocation mocks override suite-wide mocks for matching keys.
    const mergedMocks = { ...suiteMocks, ...(opts.mocks ?? {}) }
    const effectiveMocks = Object.keys(mergedMocks).length ? mergedMocks : null
    const dispose = addScope((entry) => toolCalls.push(entry), effectiveMocks)

    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            ...(opts.contextId && { contextId: opts.contextId }),
            ...(opts.taskId && { taskId: opts.taskId }),
            parts: [{ kind: "text", text: query }],
          },
        },
      }

      const url = service.startsWith("/") ? service : `/a2a/${service}/`
      // Suppress W3C trace-context propagation so the server-side HTTP span
      // becomes a true root in MLflow. Without this, instrumentation-http on
      // the server picks up the test worker's traceparent and makes every
      // server span a child of a span that never reaches MLflow — leaving the
      // trace permanently IN_PROGRESS.
      // Also pass the active eval run ID so MLflow can link the trace to the run.
      const res = await axios.post(url, body, {
        validateStatus: () => true,
        headers: {
          traceparent: null,
          tracestate: null,
          ...(_runId && { "x-eval-run-id": _runId }),
        },
      })

      if (res.status !== 200) {
        throw new Error(
          `runAgent: HTTP ${res.status} at ${url} — ${_stringify(res.data).slice(0, 500)}`,
        )
      }
      if (res.data?.error) {
        throw new Error(`runAgent: JSON-RPC error — ${_stringify(res.data.error)}`)
      }
      const task = res.data?.result
      if (!task) throw new Error(`runAgent: no result in response — ${_stringify(res.data)}`)

      const state = task.status?.state
      if (state === "failed") {
        throw new Error(`runAgent: task failed — ${_extractText(task) || "no message"}`)
      }
      if (state === "input-required") {
        throw new Error(
          `runAgent: task requires user input (HITL not supported yet) — ${_extractText(task)}`,
        )
      }
      if (state !== "completed") {
        throw new Error(`runAgent: unexpected terminal state '${state}'`)
      }

      const traceId = res.headers?.["x-trace-id"] ?? undefined
      return { text: _extractText(task), toolCalls, toolWasCalled, task, raw: res.data, traceId }
    } finally {
      dispose()
    }

    /**
     * Returns true if at least one recorded tool call in THIS invocation
     * matches. Non-throwing — intended for `expect(...).toBe(true)`.
     *
     *   toolWasCalled("query")                                — any call
     *   toolWasCalled("query", { entity: "Books" })           — partial object match
     *   toolWasCalled("query", { entity: "Books" }, { exact: true })
     *   toolWasCalled("query", (args) => args.includes("stock"))
     *
     * The function matcher receives the JSON-stringified args as its first
     * argument (so `args.includes(...)` / regex tests just work), and the
     * raw args object as its second argument for property inspection:
     *
     *   toolWasCalled("query", (_, raw) => raw.entity === "Books")
     *
     * For anything richer (counts, combined predicates over multiple calls),
     * read `toolCalls` directly.
     */
    function toolWasCalled(name, matcher, opts = {}) {
      const exact = !!opts.exact
      return toolCalls.some((c) => c.tool === name && _argsMatch(c.args, matcher, exact))
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // LLM-as-judge
  // ────────────────────────────────────────────────────────────────────────

  async function createEvalJudge({ model, prompt, feedbackKey, continuous } = {}) {
    // Save/restore globalThis.expect around the openevals import:
    // openevals pulls in `langsmith`, whose `utils/jestlike/vendor/chain.js`
    // runs `globalThis.expect = wrapExpect(globalThis.expect)` at load time.
    // The wrapper returns plain objects with only `.evaluatedBy(...)`, dropping
    // every Jest/chai matcher (e.g. `.toBeGreaterThanOrEqual`). We don't use
    // langsmith's `.evaluatedBy` flow, so we simply restore vitest's expect.
    const savedExpect = globalThis.expect

    let openevals
    try {
      openevals = await import("openevals")
    } catch (err) {
      throw new Error(
        "openevals is required for createEvalJudge(). Install it as a devDependency:\n" +
          "  npm install --save-dev openevals\n" +
          `Original error: ${err.message}`,
      )
    }
    const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")

    if (savedExpect && globalThis.expect !== savedExpect) {
      globalThis.expect = savedExpect
    }

    const modelName = model || process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL

    const judge = new OrchestrationClient({
      promptTemplating: { model: { name: modelName, params: { temperature: 0 } } },
    })
    // Prevent the judge's LLM calls from being recorded as agent traces in MLflow.
    judge[Symbol.for("@cap-js/agents:instrumented")] = true

    return openevals.createLLMAsJudge({
      judge,
      prompt: prompt || DEFAULT_JUDGE_PROMPT,
      continuous: continuous !== false,
      feedbackKey: feedbackKey || "score",
    })
  }

  async function evaluate(judge, { query, criteria, response, label, traceId } = {}) {
    if (typeof judge !== "function") {
      throw new Error("evaluate: judge must be the function returned by createEvalJudge()")
    }
    const judgement = await judge({
      inputs: `Question: ${query}\nCriteria: ${criteria}`,
      outputs: response,
    })
    const score = judgement?.score
    const tag = label ?? "eval"
    // eslint-disable-next-line no-console
    console.log(`  [${tag}] score=${score} — ${judgement?.comment ?? ""}`)
    if (score != null) _scores.push(score)
    if (traceId) {
      await flushMlflowTraces()
      await postMlflowAssessment(traceId, score, judgement?.comment ?? "", tag)
    }
    return judgement
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers (module-scope, pure)
// ──────────────────────────────────────────────────────────────────────────

function _extractText(task) {
  const artifacts = task.artifacts || []
  for (const a of artifacts) {
    const text = (a.parts || [])
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("")
    if (text) return text
  }
  const msg = task.status?.message
  if (msg?.parts) {
    return msg.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("")
  }
  return ""
}

function _stringify(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function _argsMatch(actual, matcher, exact) {
  if (matcher === undefined) return true
  if (typeof matcher === "function") {
    try {
      return !!matcher(_stringify(actual ?? ""), actual)
    } catch {
      return false
    }
  }
  return exact ? _deepEqual(actual, matcher) : _deepContains(actual, matcher)
}

function _deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!_deepEqual(a[k], b[k])) return false
  }
  return true
}

function _deepContains(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected
  if (actual === null || typeof actual !== "object") return false
  if (Array.isArray(expected)) return _deepEqual(actual, expected)
  for (const k of Object.keys(expected)) {
    const ev = expected[k]
    const av = actual[k]
    if (ev !== null && typeof ev === "object" && !Array.isArray(ev)) {
      if (!_deepContains(av, ev)) return false
    } else if (Array.isArray(ev)) {
      if (!_deepEqual(av, ev)) return false
    } else {
      if (av !== ev) return false
    }
  }
  return true
}
