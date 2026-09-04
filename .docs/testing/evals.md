# Agent Evals

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

Eval tests run your agent against real LLM calls and can score responses with an LLM-as-judge. Results, metrics, and validation rollups are posted to MLflow automatically if MLflow is enabled.

## Setup

Install optional peer dependencies:

```bash
npm install --save-dev openevals
```

Run a specific eval test with your project’s binding/profile setup, for example:

```bash
CDS_ENV=test,hybrid,tracing cds bind --exec -- npx vitest run test/eval/<scenario>.test.js
```

## Writing eval tests

```js
import cds from "@sap/cds"
import { test } from "vitest"
import { Judge, matchToolCall } from "@cap-js/agents/eval"

cds.test(".")

const judge = new Judge("Response fully and accurately answers the user's question.")

describe("catalog-eval", () => {
  test("lists books", async () => {
    const agent = await cds.connect.to("CatalogService")
    const result = await agent.chat("Show me all books")

    // OTel-derived metrics are available in the test profile and posted to MLflow.
    expect(result.metrics.tool_call_count).toBeGreaterThan(0)

    // Deterministic validation; also contributes to eval rollups.
    expect(matchToolCall(result, "query", (args) => !!args.cql)).toBe(true)

    // LLM-as-judge validation; also contributes to eval rollups.
    const { pass, score, comment } = await judge
      .criteria("must list multiple books with titles")
      .evaluate(result)

    expect(pass).toBe(true)
  })
})
```

For multi-turn or HITL evals, pass the previous `agent.chat()` result to continue the same context. If the previous result has status `input-required`, the same task is resumed.

```js
test("approves an order", async () => {
  const agent = await cds.connect.to("CatalogService")

  const r1 = await agent.chat("Show me all books")
  const r2 = await agent.chat("Order the cheapest one", r1)
  expect(r2.status).toBe("input-required")

  const r3 = await agent.chat("yes", r2)
  expect(r3.status).toBe("completed")

  const { pass } = await new Judge("The final response confirms the order.").evaluate(r3)
  expect(pass).toBe(true)
})
```

## Eval run lifecycle in MLflow

Importing from `@cap-js/agents/eval` installs eval test integration for top-level `describe("name", ...)` blocks. The describe name is used as the eval run name.

Rules:

- Import from `@cap-js/agents/eval` before declaring the top-level `describe`.
- Use the global `describe`; do not import `describe` from `vitest`, because imported bindings bypass the global patch.
- Only top-level `describe` blocks create eval runs; nested `describe` blocks are grouping only.
- Skipped and todo suites do not create eval runs.

Validation helpers such as `matchToolCall()` and `judge.evaluate()` contribute to per-test rollups. When MLflow is enabled, those rollups are flushed automatically.

## `agent.chat(query, previous?)`

`agent.chat()` calls the agent in-process. It is registered on `@agent` services by the agent service handlers and is intended for tests and evals.

```js
await agent.chat("Show me all books")
await agent.chat("Order it", previousResult)
```

The typical result:

```js
result.text // final text response
result.status // "completed" | "input-required" | "canceled"
result.contextId // conversation id — pass to the next chat() for multi-turn
result.taskId // task id — used for HITL resume
```

When the `test` profile is active, additional eval details are available:

```js
result.query // original query string, used by judges
result.traceId // OTel trace id
result.toolCalls // [{ tool, args, result?, cqn? }]
result.messages // LangChain messages for the current turn
result.spans // OTel spans captured for the trace
result.metrics // input/output tokens, tool count, latency, cost
```

## `Judge`

`Judge` evaluates one `agent.chat()` result and returns `{ score, comment, pass }`.

```js
const { score, comment, pass } = await new Judge(
  "Answer must mention at least one concrete book title.",
).evaluate(result)
```

The constructor accepts one argument:

```js
await new Judge("ANSWER_RELEVANCE_PROMPT").evaluate(result)
await new Judge({ criteria: "ANSWER_RELEVANCE_PROMPT", continuous: false }).evaluate(result)
```

`criteria` is used as the judge prompt source:

- if it matches an `openevals` prompt export such as `ANSWER_RELEVANCE_PROMPT`, the built-in prompt is used
- otherwise the string is passed as the prompt

Use `.criteria(text)` to append additional instructions to the existing criteria. It returns a sibling judge and does not replace the original criteria.

```js
const base = new Judge("Response must answer the user question.")

await base.criteria("Response must include stock information.").evaluate(result)
```

Other possible prompts are in the [OpenEvals prebuilt prompts](https://github.com/langchain-ai/openevals#prebuilt-prompts).

## `TrajectoryJudge`

`TrajectoryJudge` evaluates `result.messages` and with that the steps the agent took, not only the final answer.

```js
import { TrajectoryJudge } from "@cap-js/agents/eval"

const { pass, score, comment } = await new TrajectoryJudge()
  .criteria("Agent must call getStock before stating a stock level.")
  .evaluate(result)

expect(pass).toBe(true)
```

By default, `TrajectoryJudge` uses `TRAJECTORY_ACCURACY_PROMPT`. Other trajectory prompt keys from OpenEvals can be used through the same constructor. See the [OpenEvals trajectory prompts](https://github.com/langchain-ai/openevals#trajectory-prompts).

```js
await new TrajectoryJudge("TRAJECTORY_ACCURACY_PROMPT").evaluate(result)
```

## `ConversationJudge`

`ConversationJudge` evaluates a full session instead of a single turn. Pass all `agent.chat()` results for the conversation in order.

```js
import { ConversationJudge } from "@cap-js/agents/eval"

const r1 = await agent.chat("How many copies of Wuthering Heights are in stock?")
const r2 = await agent.chat("Tell me more about that book.", r1)

const { pass, score, comment } = await new ConversationJudge("TASK_COMPLETION_PROMPT").evaluate([
  r1,
  r2,
])

expect(pass).toBe(true)
```

`ConversationJudge` evaluates the collected messages from all passed results. It defaults to `TASK_COMPLETION_PROMPT` and posts the assessment with session metadata when MLflow is enabled.

Other conversation prompt keys from OpenEvals can be used with the same base class. See the [OpenEvals conversation prompts](https://github.com/langchain-ai/openevals#conversation-prompts).

```js
await new ConversationJudge("KNOWLEDGE_RETENTION_PROMPT").evaluate([r1, r2])
```

## `matchToolCall(result, toolName, matcher?)`

`matchToolCall()` is a deterministic tool-call assertion. It returns a boolean and contributes to eval rollups.

```js
matchToolCall(result, "query") // any call with that tool name
matchToolCall(result, "query", { entity: "Books" }) // partial args match
matchToolCall(result, "getStock", (args) => args.book === 42) // predicate
```
