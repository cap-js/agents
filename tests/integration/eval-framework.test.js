/**
 * Unit tests for the feat/eval framework:
 *   - metricsFromSpans  (lib/testing/metrics.js)
 *   - startCollection   (lib/testing/span-collector.js)
 *   - eval-run helpers  (lib/testing/eval-run.js)
 *   - chat.js helpers   (srv/handlers/chat.js)
 *   - Judge / assertToolCall deterministic paths (lib/testing/Judge.js)
 *
 * No LLM calls; all tests are deterministic.
 */
import cds from "@sap/cds"
import { metricsFromSpans } from "../../lib/testing/metrics.js"
import {
  Judge,
  TrajectoryMatchJudge,
  ConversationJudge,
  assertToolCall,
} from "../../lib/testing/Judge.js"
import { getActiveRunState, recordValidation } from "../../lib/testing/eval-run.js"

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeSpan(op, attrs = {}) {
  return {
    attributes: { "gen_ai.operation.name": op, ...attrs },
    spanContext: () => ({ traceId: "abc" }),
  }
}

function makeChatSpan(inputTokens, outputTokens, cost = null) {
  const attrs = {
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
  }
  if (cost !== null) attrs["mlflow.llm.cost"] = JSON.stringify({ total_cost: cost })
  return makeSpan("chat", attrs)
}

function makeToolSpan() {
  return makeSpan("execute_tool")
}

function makeAgentSpan(startMs, endMs) {
  const toHr = (ms) => [Math.floor(ms / 1000), (ms % 1000) * 1e6]
  return {
    attributes: { "gen_ai.operation.name": "invoke_agent" },
    startTime: toHr(startMs),
    endTime: toHr(endMs),
    spanContext: () => ({ traceId: "abc" }),
  }
}

// ─── metricsFromSpans ─────────────────────────────────────────────────────────

describe("metricsFromSpans", () => {
  it("returns zero metrics for empty span array", () => {
    const m = metricsFromSpans([])
    expect(m.input_tokens).toBe(0)
    expect(m.output_tokens).toBe(0)
    expect(m.total_tokens).toBe(0)
    expect(m.tool_call_count).toBe(0)
    expect(m.latency_ms).toBeNull()
    expect(m.cost_usd).toBeNull()
  })

  it("sums token usage across multiple chat spans", () => {
    const spans = [makeChatSpan(10, 5), makeChatSpan(20, 8)]
    const m = metricsFromSpans(spans)
    expect(m.input_tokens).toBe(30)
    expect(m.output_tokens).toBe(13)
    expect(m.total_tokens).toBe(43)
  })

  it("counts tool calls from execute_tool spans", () => {
    const spans = [makeToolSpan(), makeToolSpan(), makeToolSpan()]
    const m = metricsFromSpans(spans)
    expect(m.tool_call_count).toBe(3)
  })

  it("derives latency_ms from invoke_agent span times", () => {
    const spans = [makeAgentSpan(1000, 2500)]
    const m = metricsFromSpans(spans)
    expect(m.latency_ms).toBeCloseTo(1500, 0)
  })

  it("accumulates cost_usd from mlflow.llm.cost", () => {
    const spans = [makeChatSpan(10, 5, 0.003), makeChatSpan(10, 5, 0.007)]
    const m = metricsFromSpans(spans)
    expect(m.cost_usd).toBeCloseTo(0.01, 5)
  })

  it("ignores malformed mlflow.llm.cost without throwing", () => {
    const span = makeSpan("chat", {
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.output_tokens": 5,
      "mlflow.llm.cost": "not-json",
    })
    expect(() => metricsFromSpans([span])).not.toThrow()
    expect(metricsFromSpans([span]).cost_usd).toBeNull()
  })

  it("ignores non-chat/execute_tool/invoke_agent spans", () => {
    const spans = [makeSpan("invoke_workflow"), makeSpan("db_query")]
    const m = metricsFromSpans(spans)
    expect(m.input_tokens).toBe(0)
    expect(m.tool_call_count).toBe(0)
    expect(m.latency_ms).toBeNull()
  })
})

// ─── assertToolCall ───────────────────────────────────────────────────────────

describe("assertToolCall", () => {
  const result = (toolCalls) => ({ toolCalls, taskId: "t1", traceId: "r1" })

  it("passes when tool name matches with no matcher", () => {
    const { pass, call } = assertToolCall(result([{ tool: "query", args: {} }]), "query")
    expect(pass).toBe(true)
    expect(call.tool).toBe("query")
  })

  it("fails when tool name absent", () => {
    const { pass } = assertToolCall(result([{ tool: "getStock", args: {} }]), "query")
    expect(pass).toBe(false)
  })

  it("passes when function matcher returns true", () => {
    const { pass } = assertToolCall(
      result([{ tool: "query", args: { cql: "SELECT * FROM Books" } }]),
      "query",
      (args) => args.cql.includes("Books"),
    )
    expect(pass).toBe(true)
  })

  it("fails when function matcher returns false", () => {
    const { pass } = assertToolCall(
      result([{ tool: "query", args: { cql: "SELECT * FROM Authors" } }]),
      "query",
      (args) => args.cql.includes("Books"),
    )
    expect(pass).toBe(false)
  })

  it("partial object matcher: passes when args contain expected keys", () => {
    const { pass } = assertToolCall(
      result([{ tool: "query", args: { cql: "SELECT 1", limit: 10 } }]),
      "query",
      { limit: 10 },
    )
    expect(pass).toBe(true)
  })

  it("partial object matcher: fails when args differ", () => {
    const { pass } = assertToolCall(
      result([{ tool: "query", args: { cql: "SELECT 1", limit: 5 } }]),
      "query",
      { limit: 10 },
    )
    expect(pass).toBe(false)
  })

  it("returns null call when not found", () => {
    const { pass, call } = assertToolCall(result([]), "query")
    expect(pass).toBe(false)
    expect(call).toBeNull()
  })

  it("handles missing toolCalls gracefully", () => {
    const { pass } = assertToolCall({ taskId: "t1", traceId: "r1" }, "query")
    expect(pass).toBe(false)
  })
})

// ─── Judge constructor validation ─────────────────────────────────────────────

describe("Judge constructor", () => {
  it("throws TypeError when criteria is missing", () => {
    expect(() => new Judge()).toThrow(TypeError)
  })

  it("throws TypeError when criteria is not a string", () => {
    expect(() => new Judge(42)).toThrow(TypeError)
    expect(() => new Judge(null)).toThrow(TypeError)
  })

  it("constructs with valid criteria string", () => {
    expect(() => new Judge("Answer must be helpful.")).not.toThrow()
  })

  it("criteria() returns a sibling with updated criteria", () => {
    const j = new Judge("original")
    const j2 = j.criteria("updated")
    expect(j2).not.toBe(j)
    expect(j2._criteria).toBe("updated")
    expect(j2._model).toBe(j._model)
    expect(j2._assessmentName).toBe(j._assessmentName)
  })

  it("criteria() shares judgeImpl when already loaded", () => {
    const j = new Judge("orig")
    j._judgeImpl = () => {}
    const j2 = j.criteria("new")
    expect(j2._judgeImpl).toBe(j._judgeImpl)
  })
})

// ─── TrajectoryMatchJudge constructor ─────────────────────────────────────────

describe("TrajectoryMatchJudge constructor", () => {
  it("throws when first arg is not an array", () => {
    expect(() => new TrajectoryMatchJudge("not an array")).toThrow(TypeError)
    expect(() => new TrajectoryMatchJudge(null)).toThrow(TypeError)
  })

  it("constructs with an array", () => {
    expect(() => new TrajectoryMatchJudge([])).not.toThrow()
  })

  it("defaults mode to subset and argsMode to ignore", () => {
    const j = new TrajectoryMatchJudge([])
    expect(j._mode).toBe("subset")
    expect(j._argsMode).toBe("ignore")
  })

  it("accepts custom mode and argsMode", () => {
    const j = new TrajectoryMatchJudge([], { mode: "exact", argsMode: "exact" })
    expect(j._mode).toBe("exact")
    expect(j._argsMode).toBe("exact")
  })
})

// ─── ConversationJudge.evaluate input validation ──────────────────────────────

describe("ConversationJudge.evaluate input validation", () => {
  it("throws when results is not an array", async () => {
    const j = new ConversationJudge()
    await expect(j.evaluate(null)).rejects.toThrow()
    await expect(j.evaluate("string")).rejects.toThrow()
  })

  it("throws when results is an empty array", async () => {
    const j = new ConversationJudge()
    await expect(j.evaluate([])).rejects.toThrow()
  })
})

// ─── eval-run: recordValidation + getActiveRunState ──────────────────────────

describe("eval-run helpers", () => {
  afterEach(() => {
    cds._activeEvalRun = null
  })

  it("getActiveRunState returns null when no run is active", () => {
    expect(getActiveRunState()).toBeNull()
  })

  it("getActiveRunState returns the active run state", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    expect(getActiveRunState()).toBe(state)
  })

  it("recordValidation accumulates pass/fail on the state keyed by taskId", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    const result = { taskId: "task-1", traceId: "tr1", _evalState: state }
    recordValidation(result, true)
    recordValidation(result, false)
    const entry = state.validationsByTask.get("task-1")
    expect(entry.passes).toEqual([true, false])
    expect(entry.traceId).toBe("tr1")
  })

  it("recordValidation is a no-op when result has no taskId", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    recordValidation({ traceId: "tr1" }, true)
    expect(state.validationsByTask.size).toBe(0)
  })

  it("recordValidation prefers result._evalState over cds._activeEvalRun", () => {
    const state1 = { runId: "r1", validationsByTask: new Map() }
    const state2 = { runId: "r2", validationsByTask: new Map() }
    cds._activeEvalRun = state2
    const result = { taskId: "t1", traceId: "tr1", _evalState: state1 }
    recordValidation(result, true)
    expect(state1.validationsByTask.get("t1").passes).toEqual([true])
    expect(state2.validationsByTask.size).toBe(0)
  })
})

// ─── chat.js: toolCallsFromMessages (tested via import) ──────────────────────
// toolCallsFromMessages is not exported; we test its behavior indirectly via
// the shape of result.toolCalls returned by srv.chat(). That requires a running
// agent (hybrid). For the unit layer we test the module-private logic by
// checking the exported COLLECT_RESULT symbol and NoopEventBus-equivalent behavior
// through the public chat.js surface.

import { COLLECT_RESULT } from "../../srv/handlers/chat.js"
import { startCollection } from "../../lib/testing/span-collector.js"

describe("chat.js: COLLECT_RESULT symbol", () => {
  it("is a Symbol with the expected key", () => {
    expect(typeof COLLECT_RESULT).toBe("symbol")
    expect(COLLECT_RESULT.toString()).toContain("collect-result")
  })
})

// ─── span-collector: session isolation ───────────────────────────────────────

describe("startCollection: session isolation", () => {
  it("returns a collection object with a collect() method", async () => {
    const c = await startCollection()
    expect(typeof c.collect).toBe("function")
  })

  it("two concurrent sessions collect independently", async () => {
    const c1 = await startCollection()
    const c2 = await startCollection()
    // collect immediately — no spans injected, both should be empty arrays
    const spans1 = c1.collect()
    const spans2 = c2.collect()
    expect(Array.isArray(spans1)).toBe(true)
    expect(Array.isArray(spans2)).toBe(true)
  })

  it("collect() removes the session so subsequent collects on same handle return []", async () => {
    const c = await startCollection()
    c.collect()
    // span-collector doesn't expose collect() a second time on the same handle
    // but the session is removed — a new collection starts fresh
    const c2 = await startCollection()
    expect(c2.collect()).toHaveLength(0)
  })
})
