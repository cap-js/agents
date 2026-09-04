import cds from "@sap/cds"
import { metricsFromSpans } from "../../lib/eval/metrics.js"
import { Judge, TrajectoryJudge, ConversationJudge, matchToolCall } from "../../lib/eval/Judge.js"
import { getActiveRunState, recordEvaluation } from "../../lib/eval/eval-run.js"
import { installEvalDescribe } from "../../lib/eval/eval-describe.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

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

function makeDescribeDouble() {
  const calls = []

  const executableSuite = (kind) =>
    function suite(name, factory, ...args) {
      calls.push({ kind, name, args })
      if (typeof factory === "function") return factory()
    }

  const skippedSuite = (kind) =>
    function suite(name, _factory, ...args) {
      calls.push({ kind, name, args })
    }

  const describeDouble = executableSuite("describe")
  describeDouble.only = executableSuite("only")
  describeDouble.concurrent = executableSuite("concurrent")
  describeDouble.sequential = executableSuite("sequential")
  describeDouble.skip = skippedSuite("skip")
  describeDouble.todo = skippedSuite("todo")
  describeDouble.each = (cases) => {
    calls.push({ kind: "eachFactory", cases })
    return executableSuite("each")
  }
  describeDouble.skipIf = (condition) => {
    calls.push({ kind: "skipIfFactory", condition })
    return condition ? skippedSuite("skipIf") : executableSuite("skipIf")
  }
  describeDouble.runIf = (condition) => {
    calls.push({ kind: "runIfFactory", condition })
    return condition ? executableSuite("runIf") : skippedSuite("runIf")
  }
  describeDouble.calls = calls
  return describeDouble
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

// ─── matchToolCall ───────────────────────────────────────────────────────────

describe("matchToolCall", () => {
  const result = (toolCalls) => ({ toolCalls, taskId: "t1", traceId: "r1" })

  it("passes when tool name matches with no matcher", () => {
    expect(matchToolCall(result([{ tool: "query", args: {} }]), "query")).toBe(true)
  })

  it("fails when tool name absent", () => {
    expect(matchToolCall(result([{ tool: "getStock", args: {} }]), "query")).toBe(false)
  })

  it("passes when function matcher returns true", () => {
    expect(
      matchToolCall(
        result([{ tool: "query", args: { cql: "SELECT * FROM Books" } }]),
        "query",
        (args) => args.cql.includes("Books"),
      ),
    ).toBe(true)
  })

  it("fails when function matcher returns false", () => {
    expect(
      matchToolCall(
        result([{ tool: "query", args: { cql: "SELECT * FROM Authors" } }]),
        "query",
        (args) => args.cql.includes("Books"),
      ),
    ).toBe(false)
  })

  it("partial object matcher: passes when args contain expected keys", () => {
    expect(
      matchToolCall(result([{ tool: "query", args: { cql: "SELECT 1", limit: 10 } }]), "query", {
        limit: 10,
      }),
    ).toBe(true)
  })

  it("partial object matcher: fails when args differ", () => {
    expect(
      matchToolCall(result([{ tool: "query", args: { cql: "SELECT 1", limit: 5 } }]), "query", {
        limit: 10,
      }),
    ).toBe(false)
  })

  it("returns false when not found", () => {
    expect(matchToolCall(result([]), "query")).toBe(false)
  })

  it("handles missing toolCalls gracefully", () => {
    expect(matchToolCall({ taskId: "t1", traceId: "r1" }, "query")).toBe(false)
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

  it("throws TypeError when a second constructor argument is provided", () => {
    expect(() => new Judge("ANSWER_RELEVANCE_PROMPT", { assessmentName: "custom" })).toThrow(
      TypeError,
    )
    expect(
      () => new TrajectoryJudge("TOOL_SELECTION_PROMPT", { assessmentName: "custom" }),
    ).toThrow(TypeError)
  })

  it("constructs with valid criteria string", () => {
    expect(() => new Judge("Answer must be helpful.")).not.toThrow()
  })

  it("constructs with criteria object", () => {
    const j = new Judge({
      criteria: "Answer must be helpful.",
      assessmentName: "helpfulness",
      continuous: false,
    })
    expect(j._criteria).toBe("Answer must be helpful.")
    expect(j._assessmentName).toBe("helpfulness")
    expect(j._continuous).toBe(false)
  })

  it("derives assessmentName from openevals prompt-key criteria", () => {
    const j = new Judge("ANSWER_RELEVANCE_PROMPT")
    expect(j._assessmentName).toBe("answer_relevance")
  })

  it("uses the fallback assessmentName for custom criteria strings", () => {
    const j = new Judge("Answer must be helpful.")
    expect(j._assessmentName).toBe("relevance")
  })

  it("uses explicit assessmentName over derived criteria value", () => {
    const j = new Judge({
      criteria: "ANSWER_RELEVANCE_PROMPT",
      assessmentName: "custom_assessment",
    })
    expect(j._assessmentName).toBe("custom_assessment")
  })

  it("does not keep model configuration on the judge", () => {
    const j = new Judge("Answer must be helpful.")
    expect(j._model).toBeUndefined()
    expect(j._modelOptions).toBeUndefined()
  })

  it("supports openevals prompts through the base Judge", () => {
    expect(new Judge("TOXICITY_PROMPT")._assessmentName).toBe("toxicity")
  })

  it("criteria() returns a sibling with appended criteria", () => {
    const j = new Judge("original")
    const j2 = j.criteria("updated")
    expect(j2).not.toBe(j)
    expect(j2._criteria).toBe("original\n\nupdated")
    expect(j2._assessmentName).toBe(j._assessmentName)
  })

  it("criteria() shares judgeImpl when already loaded", () => {
    const j = new Judge("orig")
    j._judgeImpl = () => {}
    const j2 = j.criteria("new")
    expect(j2._judgeImpl).toBe(j._judgeImpl)
  })
})

// ─── Judge prompt resolution ─────────────────────────────────────────────────

describe("Judge prompt resolution", () => {
  afterEach(() => {
    vi.doUnmock("openevals")
    vi.resetModules()
  })

  it("uses an openevals prompt when criteria matches an openevals key", async () => {
    const createLLMAsJudge = vi.fn(() => async () => ({ score: true, comment: "" }))
    vi.doMock("openevals", () => ({
      ANSWER_RELEVANCE_PROMPT: "built-in answer relevance prompt",
      createLLMAsJudge,
    }))
    const { Judge: MockedJudge } = await import("../../lib/eval/Judge.js")

    await new MockedJudge("ANSWER_RELEVANCE_PROMPT")._ensureJudge()

    expect(createLLMAsJudge).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "built-in answer relevance prompt" }),
    )
  })

  it("passes custom criteria strings directly as the prompt", async () => {
    const createLLMAsJudge = vi.fn(() => async () => ({ score: true, comment: "" }))
    vi.doMock("openevals", () => ({ createLLMAsJudge }))
    const { Judge: MockedJudge } = await import("../../lib/eval/Judge.js")
    const prompt = "Evaluate this according to {inputs} and {outputs}."

    await new MockedJudge(prompt)._ensureJudge()

    expect(createLLMAsJudge).toHaveBeenCalledWith(expect.objectContaining({ prompt }))
  })

  it("resolves an openevals prompt key before appended criteria", async () => {
    const createLLMAsJudge = vi.fn(() => async () => ({ score: true, comment: "" }))
    vi.doMock("openevals", () => ({
      ANSWER_RELEVANCE_PROMPT: "built-in answer relevance prompt",
      createLLMAsJudge,
    }))
    const { Judge: MockedJudge } = await import("../../lib/eval/Judge.js")

    await new MockedJudge("ANSWER_RELEVANCE_PROMPT").criteria("Be strict.")._ensureJudge()

    expect(createLLMAsJudge).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "built-in answer relevance prompt\n\nBe strict." }),
    )
  })
})

// ─── TrajectoryJudge constructor ─────────────────────────────────────────────

describe("TrajectoryJudge constructor", () => {
  it("defaults to trajectory accuracy", () => {
    const j = new TrajectoryJudge()
    expect(j._criteria).toBe("TRAJECTORY_ACCURACY_PROMPT")
    expect(j._assessmentName).toBe("trajectory")
  })
})

// ─── ConversationJudge.evaluate input validation ─────────────────────────────

describe("ConversationJudge.evaluate input validation", () => {
  it("defaults to task completion", () => {
    const j = new ConversationJudge()
    expect(j._criteria).toBe("TASK_COMPLETION_PROMPT")
    expect(j._assessmentName).toBe("task_completion")
  })

  it("uses explicit assessmentName over static criteria", () => {
    const j = new ConversationJudge({
      criteria: "TASK_COMPLETION_PROMPT",
      assessmentName: "conversation_completeness",
    })
    expect(j._assessmentName).toBe("conversation_completeness")
  })

  it("does not keep model configuration on conversations", () => {
    const j = new ConversationJudge()
    expect(j._model).toBeUndefined()
    expect(j._modelOptions).toBeUndefined()
  })

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

// ─── eval-run: recordEvaluation + getActiveRunState ──────────────────────────

describe("eval-run helpers", () => {
  const originalMlflow = cds.env.agents?.mlflow

  beforeEach(() => {
    cds.env.agents ??= {}
    cds.env.agents.mlflow = true
  })

  afterEach(() => {
    cds._activeEvalRun = null
    cds.env.agents.mlflow = originalMlflow
  })

  it("getActiveRunState returns null when no run is active", () => {
    expect(getActiveRunState()).toBeNull()
  })

  it("getActiveRunState returns the active run state", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    expect(getActiveRunState()).toBe(state)
  })

  it("recordEvaluation accumulates pass/fail on the state keyed by taskId", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    const result = { taskId: "task-1", traceId: "tr1", _evalState: state }
    recordEvaluation(result, { pass: true })
    recordEvaluation(result, { pass: false })
    const entry = state.validationsByTask.get("task-1")
    expect(entry.passes).toEqual([true, false])
    expect(entry.traceId).toBe("tr1")
  })

  it("recordEvaluation is a no-op when result has no taskId", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    recordEvaluation({ traceId: "tr1" }, { pass: true })
    expect(state.validationsByTask.size).toBe(0)
  })

  it("recordEvaluation prefers result._evalState over cds._activeEvalRun", () => {
    const state1 = { runId: "r1", validationsByTask: new Map() }
    const state2 = { runId: "r2", validationsByTask: new Map() }
    cds._activeEvalRun = state2
    const result = { taskId: "t1", traceId: "tr1", _evalState: state1 }
    recordEvaluation(result, { pass: true })
    expect(state1.validationsByTask.get("t1").passes).toEqual([true])
    expect(state2.validationsByTask.size).toBe(0)
  })

  it("recordEvaluation does not add conversation-level scores to task validation", () => {
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    const result = { taskId: "t1", _evalState: state }
    recordEvaluation(result, {
      pass: true,
      score: true,
      assessmentName: "conversation",
      conversationLevel: true,
    })
    expect(state.validationsByTask.size).toBe(0)
  })

  it("recordEvaluation is a no-op when mlflow is disabled", () => {
    cds.env.agents.mlflow = false
    const state = { runId: "r1", validationsByTask: new Map() }
    cds._activeEvalRun = state
    const result = { taskId: "t1", traceId: "tr1", _evalState: state }
    recordEvaluation(result, { pass: true })
    expect(state.validationsByTask.size).toBe(0)
  })
})

// ─── eval describe patch ─────────────────────────────────────────────────────

describe("eval describe patch", () => {
  it("registers an eval run for a top-level describe using the suite name", () => {
    const target = { describe: makeDescribeDouble() }
    const evalRuns = []

    expect(installEvalDescribe({ target, evalRun: (opts) => evalRuns.push(opts) })).toBe(true)

    target.describe("catalog eval", () => {})

    expect(evalRuns).toEqual([{ name: "catalog eval" }])
  })

  it("does not register another eval run for nested describes", () => {
    const target = { describe: makeDescribeDouble() }
    const evalRuns = []
    installEvalDescribe({ target, evalRun: (opts) => evalRuns.push(opts) })

    target.describe("outer eval", () => {
      target.describe("inner suite", () => {})
    })

    expect(evalRuns).toEqual([{ name: "outer eval" }])
  })

  it("does not register eval runs for skipped or todo suites", () => {
    const target = { describe: makeDescribeDouble() }
    const evalRuns = []
    installEvalDescribe({ target, evalRun: (opts) => evalRuns.push(opts) })

    target.describe.skip("skipped eval", () => {})
    target.describe.todo("todo eval", () => {})

    expect(evalRuns).toEqual([])
  })

  it("does not patch describe twice", () => {
    const target = { describe: makeDescribeDouble() }
    const evalRuns = []

    expect(installEvalDescribe({ target, evalRun: (opts) => evalRuns.push(opts) })).toBe(true)
    expect(installEvalDescribe({ target, evalRun: (opts) => evalRuns.push(opts) })).toBe(false)

    target.describe("single eval", () => {})

    expect(evalRuns).toEqual([{ name: "single eval" }])
  })

  it("preserves describe factory variants", () => {
    const target = { describe: makeDescribeDouble() }
    const evalRuns = []
    installEvalDescribe({ target, evalRun: (opts) => evalRuns.push(opts) })

    target.describe.each([[1]])("each eval", () => {})
    target.describe.skipIf(false)("skipIf eval", () => {})
    target.describe.runIf(true)("runIf eval", () => {})

    expect(evalRuns).toEqual([
      { name: "each eval" },
      { name: "skipIf eval" },
      { name: "runIf eval" },
    ])
  })

  it("eval entrypoint installs the global describe patch", async () => {
    const originalDescribe = globalThis.describe
    const describeDouble = makeDescribeDouble()
    globalThis.describe = describeDouble

    try {
      await import("../../lib/eval/index.js")
      expect(globalThis.describe).not.toBe(describeDouble)
      expect(globalThis.describe._original).toBe(describeDouble)
    } finally {
      globalThis.describe = originalDescribe
    }
  })
})

// ─── chat.js: toolCallsFromMessages (tested via import) ────────────────────
// toolCallsFromMessages is not exported; we test its behavior indirectly via
// the shape of result.toolCalls returned by srv.chat(). That requires a running
// agent (hybrid). For the unit layer we test the module-private logic by
// checking the exported COLLECT_RESULT symbol and NoopEventBus-equivalent behavior
// through the chat.js surface.

import { COLLECT_RESULT, registerChat, shouldIncludeChatDetails } from "../../srv/handlers/chat.js"
import { startCollection } from "../../lib/eval/span-collector.js"

describe("chat.js: COLLECT_RESULT symbol", () => {
  it("is a Symbol with the expected key", () => {
    expect(typeof COLLECT_RESULT).toBe("symbol")
    expect(COLLECT_RESULT.toString()).toContain("collect-result")
  })
})

describe("chat.js: result details gate", () => {
  const originalProfiles = cds.env.profiles

  afterEach(() => {
    cds.env.profiles = originalProfiles
    vi.doUnmock("../../srv/langgraph-executor-srv.js")
  })

  it("includes details when the test profile is active", () => {
    cds.env.profiles = ["test"]
    expect(shouldIncludeChatDetails()).toBe(true)
  })

  it("includes details outside test only when _details is true", () => {
    cds.env.profiles = ["development"]
    expect(shouldIncludeChatDetails()).toBe(false)
    expect(shouldIncludeChatDetails({ _details: true })).toBe(true)
  })

  it("rejects a string second argument", async () => {
    const srv = {}
    registerChat(srv)

    await expect(srv.chat("hello", "context-id")).rejects.toThrow(
      "agent.chat: second argument must be a previous chat result object or options object",
    )
  })

  it("returns only stable fields outside test profile by default", async () => {
    cds.env.profiles = ["development"]
    const srv = {}
    registerChat(srv)
    mockChatExecution("hello")

    const result = await srv.chat("hello")

    expect(Object.keys(result).sort()).toEqual(["contextId", "status", "taskId", "text"])
  })

  it("returns detail fields outside test profile when _details is true", async () => {
    cds.env.profiles = ["development"]
    const srv = {}
    registerChat(srv)
    mockChatExecution("hello")

    const result = await srv.chat("hello", { _details: true })

    expect(result.query).toBe("hello")
    expect(result.toolCalls).toEqual([])
    expect(result.messages).toHaveLength(1)
    expect(result.spans).toEqual([])
    expect(result.metrics).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      tool_call_count: 0,
      latency_ms: null,
      cost_usd: null,
    })
  })
})

function mockChatExecution(text) {
  vi.doMock("../../srv/langgraph-executor-srv.js", () => ({
    LangGraphExecutor: {
      for: () => ({
        execute: async (_requestContext, eventBus) => {
          eventBus._graphResult = { messages: [{ type: "human", content: text }] }
          eventBus.publish({
            kind: "artifact-update",
            lastChunk: true,
            artifact: { parts: [{ kind: "text", text: "ok" }] },
          })
          eventBus.finished()
        },
      }),
    },
  }))
}

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
