# Agent Evals

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

Eval tests run your agent against real LLM calls and score the responses with an LLM-as-judge. Results and metrics are posted to MLflow automatically if MLflow is enabled.

## Setup

Install optional peer dependencies:

```bash
npm install --save-dev openevals
```

Add a script to `package.json`:

```json
{
  "scripts": {
    "test:evals": "CDS_ENV=test,hybrid,tracing cds bind --exec -- vitest run"
  }
}
```

## Writing eval tests

```js
import cds from "@sap/cds"
import { test } from "vitest"
import { Judge, TrajectoryJudge, ConverstationJudge, matchToolCall } from "@cap-js/agents"

cds.test(".")

const judge = new Judge("ANSWER_RELEVANCE_PROMPT").criteria(
  "Response fully and accurately answers the user's question.",
)

describe("catalog-eval", () => {
  test("lists books", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("Show me all books")

    // result.metrics — OTel-derived, populated and posted to MLflow ootb
    expect(result.metrics.tool_call_count).toBeGreaterThan(0)

    // Deterministic tool call assertion
    expect(matchToolCall(result, "query", (args) => !!args.cql)).toBe(true)

    // LLM judge
    const { pass, comment, score } = await judge
      .criteria("must list multiple books with titles")
      .evaluate(result)
    expect(pass).toBe(true)
    // success_rate + output_correctness computed from all validations and posted to MLflow in afterEach
  })

  test("HITL", async () => {
    const agent = await cds.connect.to("CatalogService")
    const r1 = await agent.chat("Show me all books")
    // r1 threads contextId
    const r2 = await agent.chat("Which is cheapest?", r1)
    const r3 = await agent.chat("Order it", r2)
    // result.messages does not include previous conversation entries
    expect(r3.messages?.length).toBe(2)

    // HITL
    expect(r3.status).toBe("input-required")
    // approve — resumes task
    const r4 = await agent.chat("yes", r2)
    expect(r4.status).toBe("completed")

    // Use ConverstationJudge to evaluate the whole session
    const { pass } = await new ConverstationJudge("AGENT_TONE_PROMPT").evaluate([r1, r2, r3, r4])
    expect(pass).toBe(true)
  })
})
```

## Eval run lifecycle

Importing from `@cap-js/agents` automatically creates an MLflow eval run for each top-level `describe("name", ...)` block. The `describe` name is used as the MLflow run name.

```js
describe("catalog-eval", () => {
  test("lists books", async () => {
    // logged under the MLflow run named "catalog-eval"
  })
})
```

Rules:

- import `@cap-js/agents` before declaring the top-level `describe`
- use the global `describe`; do not import `describe` from `vitest`, because imported bindings bypass the global patch
- only top-level `describe` blocks create eval runs; nested `describe` blocks are regular grouping only
- skipped and todo suites do not create eval runs
- validation rollups are flushed after each test and once again when the suite finishes

Call `evalRun({ name })` manually at file top level before defining tests to start a run, if the global describe is not an option.

<details>
<summary>What an eval run entails</summary>

Registers vitest `beforeAll` / `afterEach` / `afterAll` hooks for an MLflow Run. Importing `@cap-js/agents` calls this automatically for each top-level `describe`, using the suite name as `opts.name`.

If MLflow is not configured or vitest globals are absent, it's a no-op.

**What gets posted to MLflow per `chat()` call:**

- `input_tokens`, `output_tokens`, `total_tokens`, `tool_call_count`, `latency_ms`, `cost_usd` — run metrics
- Per-turn judge assessments

**What gets posted in `afterEach` (per test):**

- `success_rate` — `1` if all `matchToolCall` + `judge.evaluate()` calls passed, `0` otherwise
- `output_correctness` — fraction of validations that passed

</details>

## `agent.chat(query, contextId?, opts?)`

Calls the agent in-process. Returns a result object.

```js
const result = await agent.chat("Show me all books")

result.text // "Here are the books: ..."
result.contextId // conversation id — pass to next chat() for multi-turn
result.taskId // task id — used for HITL resume
result.status // "completed" | "input-required" | "canceled"
```

When the `test` profile is active additional properties are available on the result

```js
result.query // "Show me all books", required for Judges
result.traceId // OTel trace id
result.toolCalls // [{ tool, args, result?, cqn? }] - cqn is populated for the query tool call
result.messages // full LangChain message array
result.spans // OTel spans captured during execution for the traceId
result.metrics // { input_tokens, output_tokens, total_tokens, tool_call_count, latency_ms, cost_usd } captured from OTEL spans
```

## Single-turn judges

Single-turn judges evaluate one `chat()` result. All return `{ score, comment, pass }` and automatically accumulate `pass` into the per-test validation set — flushed as `success_rate` and `output_correctness` to MLflow in `afterEach`.

```js
const { score, comment, pass } = await judge.evaluate(result)
```

`.criteria(text)` returns a sibling judge with appended criteria, sharing the initialized LLM:

```js
await judge.criteria("must state a concrete stock level").evaluate(result)
```

### `Judge`

Base judge. The constructor accepts one argument:

- a string shorthand, treated as `criteria`
- or an object, for example `{ criteria: "ANSWER_RELEVANCE_PROMPT", assessmentName: "answer_relevance", continuous: true }`

`criteria` is used as the judge prompt source:

- if it matches an `openevals` prompt export such as `ANSWER_RELEVANCE_PROMPT`, the built-in prompt is used
- else the string is passed as a prompt template string

Use `.criteria(text)` to append additional instructions to the current prompt/criteria.

### Single-turn openevals prompts

Use these with `Judge`, for example:

```js
await new Judge({ criteria: "TOXICITY_PROMPT", continuous: false }).evaluate(result)
await new Judge({ criteria: "CONCISENESS_PROMPT", continuous: true }).evaluate(result)
```

The `Judge` defaults to `ANSWER_RELEVANCE_PROMPT`. Other possible prompts are in the [openevals docs](https://github.com/langchain-ai/openevals#prebuilt-prompts).

### Trajectory judges

```js
// LLM-based — scores the full message trajectory against a criteria
const { pass } = await new TrajectoryJudge()
  .criteria("Agent must call getStock before stating a stock level.")
  .evaluate(result)
```

`TrajectoryJudge` defaults to `TRAJECTORY_ACCURACY_PROMPT`. Other possible prompts are in the [openevals docs](https://github.com/langchain-ai/openevals#trajectory-prompts).

## Conversation-level judges

Evaluate the full session — pass an array of results from the same conversation.

```js
const r1 = await agent.chat("How many copies of Wuthering Heights are in stock?")
const r2 = await agent.chat("Tell me more about that book.", r1)

const { pass } = await new ConverstationJudge("TASK_COMPLETION_PROMPT").evaluate([r1, r2])
```

`ConverstationJudge` defaults to `TASK_COMPLETION_PROMPT`. The assessment is posted to the MLflow session. Other possible prompts are in the [openevals docs](https://github.com/langchain-ai/openevals#conversation-prompts).

## `matchToolCall(result, toolName, matcher?)`

Deterministic tool call assertion. Contributes to `success_rate` rollup.

```js
matchToolCall(result, "query") // any call with that name
matchToolCall(result, "query", { entity: "Books" }) // partial args match
matchToolCall(result, "getStock", (args) => args.book === 42) // predicate
// returns boolean
```
