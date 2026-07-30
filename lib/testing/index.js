/**
 * Test-time helpers exposed on `cds.test(dir).agents` (via a lazy getter on
 * `Test.prototype` installed by cds-plugin.js).
 *
 * Surface:
 *   - runAgent(service, query, opts?)   — send a query to an @agent CAP
 *                                         service via the A2A protocol.
 *                                         Returns `{ text, toolCalls,
 *                                         toolWasCalled, task, raw }`.
 *                                         `toolCalls` and `toolWasCalled`
 *                                         are per-invocation.
 *   - createEvalJudge(opts?)            — LLM-as-judge factory (openevals +
 *                                         SAP AI Core OrchestrationClient).
 *   - evaluate(judge, {…})              — score + log helper (no assertion).
 *
 * `openevals` is an optional peer dependency — importing `createEvalJudge`
 * without it installed throws a clear message.
 *
 * Statelessness: all recorded tool-call state lives inside a `runAgent` call's
 * closure and is disposed on return. No shared arrays across invocations.
 * Known limitation: multiple `runAgent` calls running concurrently in the
 * SAME Node process will each see the union of tool calls in the overlap
 * window — Vitest's default file-parallel/test-serial execution avoids this.
 */

import cds from "@sap/cds"
import { addRecorder, ensureToolRecordingPatch } from "./tool-recorder.js"

const DEFAULT_JUDGE_MODEL = "anthropic--claude-4.5-haiku"

const DEFAULT_JUDGE_PROMPT = `You are an expert evaluator for an AI assistant.

User question: {inputs}
Actual response: {outputs}

Score 0.0-1.0: does the response fully satisfy the criteria specified in the user question context?
Explain your reasoning, then end with: Thus, the score should be: SCORE_YOU_ASSIGN.`

/** Build the `.agents` helper bag for a single `cds.test(...)` instance. */
export function buildAgentsHelpers(testCtx) {
  // Kick off the (idempotent) prototype patch. No hooks are attached here —
  // each `runAgent` scopes its own recorder.
  ensureToolRecordingPatch().catch(() => {
    /* langchain not present — runAgent's toolCalls will just stay empty */
  })

  return { runAgent, createEvalJudge, evaluate }

  // ────────────────────────────────────────────────────────────────────────
  // A2A driver
  // ────────────────────────────────────────────────────────────────────────

  async function runAgent(service, query, opts = {}) {
    const axios = testCtx.axios
    if (!axios) throw new Error("cds.test(...).agents.runAgent: no axios on test context")

    const toolCalls = []
    const dispose = addRecorder((entry) => toolCalls.push(entry))

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

      const url = `/a2a/${service}/`
      const res = await axios.post(url, body, { validateStatus: () => true })

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

      return { text: _extractText(task), toolCalls, toolWasCalled, task, raw: res.data }
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

    const modelName = model || process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL

    return openevals.createLLMAsJudge({
      judge: new OrchestrationClient({
        promptTemplating: { model: { name: modelName, params: { temperature: 0 } } },
      }),
      prompt: prompt || DEFAULT_JUDGE_PROMPT,
      continuous: continuous !== false,
      feedbackKey: feedbackKey || "score",
    })
  }

  async function evaluate(judge, { query, criteria, response, label } = {}) {
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
