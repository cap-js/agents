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
  const result = await agent.ask("Show me all books")

  // result.metrics — OTel-derived, populated and posted to MLflow ootb
  expect(result.metrics.tool_call_count).toBeGreaterThan(0)
  expect(result.metrics.latency_ms).toBeGreaterThan(0)

  // Deterministic tool call assertion
  const { pass } = assertToolCall(result, "query", (args) => !!args.cql)
  expect(pass).toBe(true)

  // LLM judge
  const { score, pass: judgePass } = await judge
    .criteria("must list multiple books with titles")
    .evaluate(result)
  expect(judgePass).toBe(true)

  // All assertToolCall + judge.evaluate() calls accumulate pass/fail on result
  // after each test success_rate + output_correctness of all judge.evaluate calls are calculated and send to MLFlow
})
```

## `agent.ask(query, contextId?, opts?)`

Calls the agent in-process. Returns a result object.

```js
const result = await agent.ask("Show me all books")

result.text // "Here are the books: ..."
result.query // "Show me all books"
result.contextId // conversation id — pass to next ask() for multi-turn
result.taskId // task id, for HITL
result.traceId // OTel trace id
result.toolCalls // [{ tool, args, result?, cqn? }]
result.messages // full LangChain message array
result.spans // OTel spans captured during execution
result.latencyMs // wall-clock duration
result.metrics // { input_tokens, output_tokens, total_tokens, tool_call_count, latency_ms, cost_usd }
result.status // Used for HITL, "input-required", "completed", "failed"
```

### HITL and multi-turn conversations

A response can be forwarded as the second argument to the next query, which causes the next query to be in the same context.

```js
const r1 = await agent.ask("Order 1 copy of book 201 hitl")
expect(r1.status).toBe("input-required")

const r2 = await agent.ask("yes", r1) // approve — r1 forwarded for resume
expect(r2.status).toBeUndefined()
```

### `result.metrics`

Populated ootb by `ask()` from OTel spans.

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

## Judges

All judges return `{ score, comment, pass }` and automatically accumulate `pass` for the `success_rate` / `output_correctness` rollup posted to MLflow by `ask()`.

```js
const { score, comment, pass } = await judge.evaluate(result)
```

`.criteria(text)` returns a sibling with new criteria, sharing the initialized LLM:

```js
await judge.criteria("must state a concrete stock level").evaluate(result)
```

### `Judge`

Base judge uses openevals `ANSWER_RELEVANCE_PROMPT`. Continuous 0–1 score.

### Safety / quality judges

| Class                | openevals prompt        | `pass` means                   |
| -------------------- | ----------------------- | ------------------------------ |
| `ToxicityJudge`      | `TOXICITY_PROMPT`       | not toxic                      |
| `FairnessJudge`      | `FAIRNESS_PROMPT`       | not biased                     |
| `ConcisenessJudge`   | `CONCISENESS_PROMPT`    | concise (continuous)           |
| `ToolSelectionJudge` | `TOOL_SELECTION_PROMPT` | good tool choices (continuous) |

### `TrajectoryJudge`

LLM scores the full message trajectory. Uses `TRAJECTORY_ACCURACY_PROMPT` via `openevals.createTrajectoryLLMAsJudge`.

```js
const { pass } = await new TrajectoryJudge(
  "Agent must call getStock before stating a stock level.",
).evaluate(result)
```

### `TrajectoryMatchJudge`

Deterministic trajectory comparison against a reference message list. Uses `openevals.createTrajectoryMatchEvaluator`. Boolean pass/fail.

```js
const judge = new TrajectoryMatchJudge(referenceMsgs, { mode: "subset", argsMode: "ignore" })
const { pass } = await judge.evaluate(result)
```

Modes: `strict`, `unordered`, `subset`, `superset`.

## `assertToolCall(result, toolName, matcher?)`

Deterministic tool call assertion. Contributes to `success_rate` rollup.

```js
assertToolCall(result, "query") // any call
assertToolCall(result, "query", { entity: "Books" }) // partial args match
assertToolCall(result, "getStock", (args) => args.book === 42) // predicate
// returns { pass: boolean, call: object|null }
```

## `evalRun(opts?)`

Registers vitest `beforeAll`/`afterAll` hooks for an MLflow Run. Must be called at file top level.

```js
evalRun({ name: "my-eval" })
```

No-op when MLflow is not configured or `beforeAll`/`afterAll` globals are not present.

**Metrics posted to MLflow for each `ask()` call:**

- `input_tokens`, `output_tokens`, `total_tokens`, `tool_call_count`, `latency_ms`, `cost_usd`
- `success_rate` — 1 if all validations passed, 0 otherwise
- `output_correctness` — fraction of validations that passed

**Conversation-level assessments:** When a multi-turn conversation is detected (same `contextId` across multiple `ask()` calls), judge assessments are posted twice — once on the current turn's trace and once as `conversation.<assessmentName>` on the first trace in the session, matching MLflow's multi-turn evaluation model.

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

  const result = await agent.ask("What is the stock of Wuthering Heights?")
  expect(result.text).toContain("999")
})
```
