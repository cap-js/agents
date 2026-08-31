# Agent Evals

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

Eval tests run your agent against real LLM calls and score the responses with an LLM-as-judge. Results and metrics are posted to MLflow automatically.

## Setup

Install optional peer dependencies:

```bash
npm install --save-dev openevals vitest
```

Add a vitest config (`vitest.config.evals.js`):

```js
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/evals/*.eval.test.js"],
    globals: true,
    environment: "node",
    restoreMocks: true,
    testTimeout: 900_000,
    hookTimeout: 30_000,
  },
})
```

Add a script to `package.json`:

```json
{
  "scripts": {
    "test:evals": "CDS_ENV=hybrid cds bind --exec -- vitest run --config vitest.config.evals.js"
  }
}
```

## Writing eval tests

```js
import cds from "@sap/cds"
import { test } from "vitest"
import { Judge, evalRun, assertToolCall } from "@cap-js/agents"

cds.test(".")
evalRun({ name: "catalog-eval" }) // Required to start a run in MLFlow

const judge = new Judge("Response fully and accurately answers the user's question.")

test("lists books", async () => {
  const agent = await cds.connect.to("CatalogService")
  const result = await agent.chat("Show me all books")

  // result.metrics — OTel-derived, populated and posted to MLflow ootb
  expect(result.metrics.tool_call_count).toBeGreaterThan(0)

  // Deterministic tool call assertion
  const { pass } = assertToolCall(result, "query", (args) => !!args.cql)
  expect(pass).toBe(true)

  // LLM judge
  const { pass: judgePass } = await judge
    .criteria("must list multiple books with titles")
    .evaluate(result)
  expect(judgePass).toBe(true)
  // success_rate + output_correctness computed from all validations and posted to MLflow in afterEach
})
```

## `agent.chat(query, contextId?, opts?)`

Calls the agent in-process. Returns a result object.

```js
const result = await agent.chat("Show me all books")

result.text // "Here are the books: ..."
result.query // "Show me all books"
result.contextId // conversation id — pass to next chat() for multi-turn
result.taskId // task id — used for HITL resume
result.traceId // OTel trace id
result.toolCalls // [{ tool, args, result?, cqn? }]
result.messages // full LangChain message array
result.spans // OTel spans captured during execution
result.latencyMs // wall-clock duration ms
result.metrics // { input_tokens, output_tokens, total_tokens, tool_call_count, latency_ms, cost_usd }
result.status // "completed" | "input-required" | "canceled"
```

### Multi-turn conversations and HITL

Pass the prior result (or its `contextId` string) as the second argument to thread the conversation:

```js
const r1 = await agent.chat("Show me all books")
const r2 = await agent.chat("Which is cheapest?", r1) // threads contextId
const r3 = await agent.chat("Order it", r1.contextId) // string shorthand

// HITL
const r4 = await agent.chat("Order 1 copy of book 201 hitl")
expect(r4.status).toBe("input-required")
const r5 = await agent.chat("yes", r4) // approve — resumes task
expect(r5.status).toBe("completed")
```

When `contextId` is reused, each turn's messages are available separately via `result.messages`.

### `result.metrics`

Populated ootb by `chat()` from OTel spans.

| Field             | Source                                        |
| ----------------- | --------------------------------------------- |
| `input_tokens`    | `gen_ai.usage.input_tokens` on chat spans     |
| `output_tokens`   | `gen_ai.usage.output_tokens` on chat spans    |
| `total_tokens`    | `input + output`                              |
| `tool_call_count` | count of `execute_tool` spans                 |
| `latency_ms`      | `invoke_agent` span duration                  |
| `cost_usd`        | `mlflow.llm.cost` span attribute (set by app) |

### `toolCalls`

Each entry has a hidden non-enumerable `cqn` property when `args.cql` is present:

```js
result.toolCalls.some((c) => c.tool === "query" && c.cqn?.SELECT?.from?.ref?.[0] === "Books")
```

## Single-turn judges

Single-turn judges evaluate one `chat()` result. All return `{ score, comment, pass }` and automatically accumulate `pass` into the per-test validation set — flushed as `success_rate` and `output_correctness` to MLflow in `afterEach`.

```js
const { score, comment, pass } = await judge.evaluate(result)
```

`.criteria(text)` returns a sibling judge with new criteria, sharing the initialized LLM:

```js
await judge.criteria("must state a concrete stock level").evaluate(result)
```

### `Judge`

Base judge. Uses openevals `ANSWER_RELEVANCE_PROMPT` — evaluates whether the response directly addresses the question/criterion. Continuous 0–1 score.

### Safety / quality judges

Boolean (`pass: true` = clean). Inverted where the prompt returns `true` for a negative condition.

| Class                | openevals prompt        | `pass` means                      |
| -------------------- | ----------------------- | --------------------------------- |
| `ToxicityJudge`      | `TOXICITY_PROMPT`       | not toxic                         |
| `FairnessJudge`      | `FAIRNESS_PROMPT`       | not biased                        |
| `ConcisenessJudge`   | `CONCISENESS_PROMPT`    | concise (continuous)              |
| `ToolSelectionJudge` | `TOOL_SELECTION_PROMPT` | appropriate tool use (continuous) |

### Trajectory judges

```js
// LLM-based — scores the full message trajectory against a criteria
const { pass } = await new TrajectoryJudge(
  "Agent must call getStock before stating a stock level.",
).evaluate(result)

// Deterministic — compares result.messages against a reference list
const judge = new TrajectoryMatchJudge(referenceMsgs, { mode: "subset", argsMode: "ignore" })
const { pass } = await judge.evaluate(result)
```

`TrajectoryMatchJudge` modes: `strict`, `unordered`, `subset`, `superset`.

## Conversation-level judges

Evaluate the full session — pass an array of results from the same conversation.

```js
const r1 = await agent.chat("How many copies of Wuthering Heights are in stock?")
const r2 = await agent.chat("Tell me more about that book.", r1)

const { pass } = await new TaskCompletionJudge().evaluate([r1, r2])
```

Assessment posted to the first result's trace with `metadata["mlflow.trace.session"] = contextId` → appears in MLflow's Sessions tab.

| Class                     | openevals prompt             | `pass`                 |
| ------------------------- | ---------------------------- | ---------------------- |
| `TaskCompletionJudge`     | `TASK_COMPLETION_PROMPT`     | all requests addressed |
| `UserSatisfactionJudge`   | `USER_SATISFACTION_PROMPT`   | user satisfied         |
| `KnowledgeRetentionJudge` | `KNOWLEDGE_RETENTION_PROMPT` | facts retained         |
| `PerceivedErrorJudge`     | `PERCEIVED_ERROR_PROMPT`     | no errors perceived    |
| `AgentToneJudge`          | `AGENT_TONE_PROMPT`          | consistent tone        |

All accept `{ model, assessmentName }` options.

## `assertToolCall(result, toolName, matcher?)`

Deterministic tool call assertion. Contributes to `success_rate` rollup.

```js
assertToolCall(result, "query") // any call with that name
assertToolCall(result, "query", { entity: "Books" }) // partial args match
assertToolCall(result, "getStock", (args) => args.book === 42) // predicate
// returns { pass: boolean, call: object|null }
```

## `evalRun(opts?)`

Registers vitest `beforeAll` / `afterEach` / `afterAll` hooks for an MLflow Run. Must be called at file top level (outside `describe`).

```js
evalRun({ name: "my-eval" })
```

No-op when MLflow is not configured or vitest globals are absent.

**What gets posted to MLflow per `chat()` call:**

- `input_tokens`, `output_tokens`, `total_tokens`, `tool_call_count`, `latency_ms`, `cost_usd` — run metrics
- Per-turn judge assessments — `assessmentName` name on the trace

**What gets posted in `afterEach` (per test):**

- `success_rate` — `1` if all `assertToolCall` + `judge.evaluate()` calls passed, `0` otherwise
- `output_correctness` — fraction of validations that passed

## Tool mocking

```js
import { vi } from "vitest"

test("mock getStock", async () => {
  const agent = await cds.connect.to("CatalogService")
  const original = agent.send.bind(agent)

  vi.spyOn(agent, "send").mockImplementation((event, ...args) => {
    if (event === "getStock" || event?.event === "getStock") return 999
    return original(event, ...args)
  })

  const result = await agent.chat("What is the stock of Wuthering Heights?")
  expect(result.text).toContain("999")
  // spy auto-restored after test (restoreMocks: true in vitest config)
})
```
