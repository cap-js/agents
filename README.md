> [!WARNING]
> This plugin is in an early experimental state and not recommended for production use.

# @cap-js/a2a

CDS protocol adapter for the [A2A (Agent-to-Agent)](https://a2a-protocol.org) protocol.

## Prerequisites

Access to an SAP AI Core instance:

- `AICORE_SERVICE_KEY` environment variable, or
- Bound via `cds bind -2 <instance>`

See [SAP Cloud SDK for AI](https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core) for details.

> [!NOTE]
> When agentifying existing services and in development profile, a mock executor is used (no AI Core needed).

## Ways to Build Agents

### Agentify Existing CAP Services

Add `@a2a` to any CDS service. The plugin auto-generates tools from entities and actions, creates a ReAct agent loop, and serves the A2A protocol with zero code required. The agent has access to the tools generated from the service model.

```cds
@a2a
service CatalogService {
  entity Books as projection on my.Books;
  action submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
```

→ See [Bookshop Sample](./tests/bookshop/)

### Markdown-Based Agents

Create agents using an agent harness like `deepagents` and plug them into CAP via `this.a2a = { graph }`. Define agent identity in `AGENTS.md`, workflows in `skills/`, and let the plugin handle protocol, persistence, agent card serving, and human-in-the-loop (HITL) approval flows.

```js
const { createDeepAgent, FilesystemBackend } = require("deepagents")
const { createDeepAgentModel, generateTools } = require("@cap-js/a2a")

module.exports = class MyAgent extends cds.ApplicationService {
  async init() {
    await super.init()
    const { tools } = generateTools(this)
    this.a2a = {
      graph: createDeepAgent({
        model: createDeepAgentModel(),
        tools,
        memory: ["./AGENTS.md"],
        skills: ["./skills/"],
        backend: new FilesystemBackend({ rootDir: __dirname + "/my-agent", virtualMode: true }),
        // checkpointer auto-injected by plugin (CdsCheckpointSaver)
      }),
    }
  }
}
```

→ See [Deep Agent Sample](./tests/deep-agent-sample/)

## Getting Started

```bash
git clone <repo-url>
cd a2a && npm i
```

Run the bookshop (zero-code agent):

```bash
cds w tests/bookshop --profile hybrid
```

Send a message:

```bash
curl -s http://localhost:4004/a2a/catalog/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"1","role":"user","parts":[{"kind":"text","text":"Which books do you have?"}]}}}'
```

## Configuration

| Setting                       | Description                                     | Default                        |
| ----------------------------- | ----------------------------------------------- | ------------------------------ |
| `cds.a2a.llm`                 | LLM model name                                  | `anthropic--claude-4.5-sonnet` |
| `cds.a2a.per_action_tool`     | One tool per action (vs combined `call_action`) | `true`                         |
| `cds.a2a.trace_langchain`     | Monkey-patch LangChain for tracing              | `true`                         |
| `cds.a2a.activeUsersInterval` | Schedule for `active_users` metric computation  | `"24h"` (`0` to disable)       |

### Executor Profiles

Only available when agentifying existing services with `@a2a` annotation.

- **`development`** - Mock executor. No LLM needed.
- **`hybrid` / `production`** - LangGraph ReAct agent with AI Core.

## Quota Enforcement

The plugin enforces configurable rate limits and resource quotas at two levels:

1. **Pre-request** — checked before graph execution starts. Returns HTTP `429` with `Retry-After` header.
2. **Per-node** — checked after each LLM iteration inside the graph. Fails the task with `state: "failed"`.

<details>
<summary>Configuration</summary>

All limits are configured via `cds.env.a2a.pool` (defaults provided by the plugin):

```json
{
  "cds": {
    "a2a": {
      "pool": {
        "maxConcurrentTasks": 5,
        "maxConcurrentTasksPerUser": 2,
        "maxTasksPerHour": 100,
        "maxTasksPerHourPerUser": 20,
        "maxLLMTokensPerDay": 500000,
        "maxToolCallsPerHour": 1000,
        "maxToolCallsPerTask": 50,
        "maxLLMInvocationsPerTask": 15,
        "maxLLMTokensPerTask": 20000,
        "maxLLMCallTimeoutMs": 30000,
        "maxExecutionTimeMsPerTask": 300000
      }
    }
  }
}
```

</details>

<details>
<summary>Pre-Request Limits (HTTP 429)</summary>

| Limit                       | Retry-After        | Scope  |
| --------------------------- | ------------------ | ------ |
| `maxConcurrentTasks`        | 30s                | Tenant |
| `maxConcurrentTasksPerUser` | 30s                | User   |
| `maxTasksPerHour`           | Next hour boundary | Tenant |
| `maxTasksPerHourPerUser`    | Next hour boundary | User   |
| `maxToolCallsPerHour`       | Next hour boundary | Tenant |
| `maxLLMTokensPerDay`        | Midnight UTC       | Tenant |

When exceeded, the response is:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1847
Content-Type: application/json

{"jsonrpc":"2.0","error":{"code":-32029,"message":"The maximum of 100 tasks per hour..."}}
```

</details>

<details>
<summary>Per-Task Limits (Task Failed)</summary>

| Limit                       | Checked at          | Effect                       |
| --------------------------- | ------------------- | ---------------------------- |
| `maxLLMInvocationsPerTask`  | After each LLM call | Graph throws → task `failed` |
| `maxLLMTokensPerTask`       | After each LLM call | Same                         |
| `maxToolCallsPerTask`       | After each LLM call | Same                         |
| `maxLLMCallTimeoutMs`       | Per LLM HTTP call   | Request aborted → error      |
| `maxExecutionTimeMsPerTask` | Timeout wrapper     | Graph throws → task `failed` |

</details>

<details>
<summary>LLM Circuit Breaker</summary>

Every LLM call is protected by a circuit breaker ([`@sap-cloud-sdk/resilience`](https://sap.github.io/cloud-sdk/docs/js/guides/resilience#circuit-breaker)) and a per-call timeout (`maxLLMCallTimeoutMs`, default 30s). This prevents cascading failures when the LLM backend is degraded.

| Parameter        | Value                               | Description                                   |
| ---------------- | ----------------------------------- | --------------------------------------------- |
| Timeout          | `maxLLMCallTimeoutMs` (30s default) | Individual HTTP call timeout                  |
| Error threshold  | 50%                                 | Opens breaker if ≥50% of calls fail in window |
| Volume threshold | 10                                  | Minimum calls in window before evaluating     |
| Reset timeout    | 30s                                 | Time before half-open test request            |

**Behavior:**

- 4xx responses (including 429 rate limits) do **not** trip the circuit breaker — only 5xx and network errors.
- When the breaker opens, all subsequent LLM calls fail immediately until the reset timeout elapses.
- After reset, one test request passes through (half-open). If successful, the breaker closes.
- The circuit breaker is always active — no opt-out configuration.

</details>

<details>
<summary>Using Per-Node Quota in Custom Graphs</summary>

For custom graphs (`this.a2a = { graph }`), import `shouldContinue` to get quota enforcement in your loop:

```js
const { StateGraph, END } = require("@langchain/langgraph")
const {
  nodes: { shouldContinue },
} = require("@cap-js/a2a")

const graph = new StateGraph(MyState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue, { tools: "tools", end: END })
  .addEdge("tools", "agent")
```

The state must include `_iterations`, `_totalTokens`, and `_totalToolCalls` fields (updated by your agent node):

```js
const MyState = Annotation.Root({
  messages: Annotation({ reducer: messagesStateReducer }),
  toolCalls: Annotation({ reducer: (_, v) => v, default: () => [] }),
  _iterations: Annotation({ reducer: (_, v) => v, default: () => 0 }),
  _totalTokens: Annotation({ reducer: (_, v) => v, default: () => 0 }),
  _totalToolCalls: Annotation({ reducer: (_, v) => v, default: () => 0 }),
})
```

When quota is exceeded, `shouldContinue` throws — the `GraphExecutor` catches it and publishes the task as `failed`.

</details>

## Audit Trail

The plugin records immutable audit logs of agent decisions, actions, tool usage, and outcomes via [`@cap-js/audit-logging`](https://github.com/cap-js/audit-logging). All events are emitted as `SecurityEvent` for compatibility with the SAP Audit Log Service.

```bash
npm add @cap-js/audit-logging
```

In development, audit events are logged to the console. In production, they are sent to the SAP Audit Log Service via the transactional outbox.

<details>
<summary>Events</summary>

| Event                | Trigger                       | Key Fields                                                                                        |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `AgentTaskStarted`   | New task submitted            | `taskId`, `contextId`, `service`, `userMessage`                                                   |
| `AgentTaskResumed`   | HITL resume (approve/reject)  | `taskId`, `contextId`, `service`, `decision`, `userMessage`                                       |
| `AgentDecision`      | LLM invocation returns        | `taskId`, `service`, `model`, `iteration`, `toolCalls`, `inputTokens`, `outputTokens`, `duration` |
| `ToolInvocation`     | Tool executed                 | `taskId`, `service`, `tool`, `args`, `outcome`, `result`, `duration`                              |
| `AgentInputRequired` | Agent requests human approval | `taskId`, `contextId`, `service`, `description`, `userMessage`                                    |
| `AgentTaskCompleted` | Task succeeds                 | `taskId`, `contextId`, `service`, `duration`, `tokens`, `toolCalls`, `output`, `task`             |
| `AgentTaskFailed`    | Task fails                    | `taskId`, `contextId`, `service`, `error`, `errorCode`, `task`                                    |
| `AgentTaskCanceled`  | Task canceled                 | `taskId`, `service`                                                                               |
| `SecurityEvent`      | Quota breach                  | `action`, `service`, `user`, `reason`, `forwardedIp` + `ip` (top-level)                           |

All events include the original event name in the `data` field for filtering and forensic reconstruction. Common fields (`uuid`, `tenant`, `user`, `time`) are auto-filled by `@cap-js/audit-logging`. Every event also carries a `correlationId` (`cds.context.id`) for cross-referencing with auto-emitted DPP events.

</details>

<details>
<summary>Coverage</summary>

| Scenario                                    | Audit coverage                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in ReAct (`@a2a` annotation)          | Full — all events fire automatically                                                                                                         |
| Custom graph (`this.a2a = { graph }`)       | Full for task lifecycle + tools using `StructuredTool`. LLM decisions covered if `model.invoke` receives `config` with `_taskId`/`_service`. |
| Custom executor (`this.a2a = { executor }`) | None — custom executors manage their own lifecycle                                                                                           |

</details>

<details>
<summary>Correlation</summary>

Events are correlated via `taskId`. For custom graphs, set `configurable._taskId` and `configurable._service` in your LangGraph config for full correlation. The plugin also sets `cds.context["a2a.task.id"]` and `cds.context["a2a.service"]` as fallback.

Every audit event includes a `correlationId` (`cds.context.id`) which is shared with auto-emitted DPP events. When a tool reads an entity annotated with `@PersonalData`, the `SensitiveDataRead` event emitted by `@cap-js/audit-logging` runs in the same CDS request context. Join on `correlationId` to trace which agent task and tool invocation triggered a personal data access.

</details>

<details>
<summary>Replay</summary>

With full audit trail, agent execution can be reconstructed:

```
AgentTaskStarted (taskId=abc)
  → AgentDecision (iteration=1, toolCalls=[query])
    → ToolInvocation (tool=query, args={entity:"Books"}, outcome=success)
  → AgentDecision (iteration=2, toolCalls=[])
AgentTaskCompleted (taskId=abc, duration=2.1s)
```

</details>

## Telemetry

When [`@cap-js/telemetry`](https://github.com/cap-js/telemetry) is installed, the plugin automatically instruments LangChain and exposes OpenTelemetry metrics. No additional configuration required.

```bash
npm add @cap-js/telemetry
```

<details>
<summary>LangChain Tracing</summary>

The plugin provides its own OpenTelemetry instrumentation — no external tracing library needed. Spans are created for each execution stage with precise names:

```
POST /a2a/CatalogService/
  └─ workflow CompiledStateGraph CatalogService
       ├─ chat anthropic--claude-4.5-sonnet
       ├─ execute_tool DynamicStructuredTool query
       ├─ chat anthropic--claude-4.5-sonnet
       └─ execute_tool DynamicStructuredTool submitOrder
```

**Privacy:** By default, spans contain only names, IDs, token counts, and outcomes — no message content. Set `DEBUG=a2a` (or `cds.log.levels.a2a: "debug"`) to include full input/output as `a2a.entity.input` and `a2a.entity.output` span attributes.

</details>

<details>
<summary>Metrics</summary>

| Metric                      | Type             | Description                                   | Attributes                                      |
| --------------------------- | ---------------- | --------------------------------------------- | ----------------------------------------------- |
| `a2a.requests.total`        | Counter          | Total inbound A2A requests                    | `sap.tenantId`, `a2a.service`, `a2a.method`     |
| `a2a.request.duration`      | Histogram (ms)   | End-to-end A2A request duration               | `sap.tenantId`, `a2a.service`, `a2a.method`     |
| `a2a.errors.total`          | Counter          | Requests resulting in error                   | `sap.tenantId`, `a2a.service`, `a2a.error.code` |
| `a2a.executions.concurrent` | UpDownCounter    | Currently active workflow executions          | `sap.tenantId`, `a2a.service`                   |
| `a2a.workflows.completed`   | Counter          | Completed agent workflows                     | `sap.tenantId`, `a2a.service`                   |
| `agent_actions`             | Counter          | Successful workflow completions per tenant    | `sap.tenantId`                                  |
| `a2a.llm.input_tokens`      | Counter          | LLM input tokens consumed                     | `sap.tenantId`, `model`, `node`                 |
| `a2a.llm.output_tokens`     | Counter          | LLM output tokens generated                   | `sap.tenantId`, `model`, `node`                 |
| `a2a.llm.invocations`       | Counter          | LLM invocation count                          | `sap.tenantId`, `model`, `node`, `outcome`      |
| `a2a.tool.invocations`      | Counter          | Tool invocation count                         | `sap.tenantId`, `tool`, `outcome`               |
| `active_users`              | Observable Gauge | Active users per service (24h rolling window) | `sap.tenantId`, `a2a.service`                   |

Error codes: `-32603` (JSON-RPC internal error), `execution_failed` (graph error), `timeout` (graph timeout).

All metrics include `sap.tenantId` from `cds.context.tenant` for multi-tenant aggregation.

The `active_users` gauge is computed periodically (default every 24h). To trigger manually:

```js
const executor = await cds.connect.to("a2a-executor")
await executor.emit("computeActiveUsers")
```

Set `cds.a2a.activeUsersInterval: 0` to disable automatic scheduling (manual trigger only).

</details>

## API

### `createDeepAgentModel(options?)`

Creates an LLM model compatible with `deepagents`. Handles array-content messages from deepagents' built-in tools that SAP AI Core would otherwise reject.

```js
const { createDeepAgentModel } = require("@cap-js/a2a")
const model = createDeepAgentModel({ params: { max_tokens: 4096, temperature: 0.2 } })
```

### `generateTools(srv)`

Generates LangChain tools from a CDS service model. Reuses tool definitions from `@cap-js/mcp`.

```js
const { generateTools } = require("@cap-js/a2a")
const { tools } = generateTools(srv)
// tools: [query, describe, ...perActionTools]
```

### `CdsCheckpointSaver`

LangGraph `BaseCheckpointSaver` backed by CDS entities. Auto-injected when using `this.a2a = { graph }`. Exported for custom executors or direct checkpoint access.

```js
const { CdsCheckpointSaver } = require("@cap-js/a2a")
const checkpointer = new CdsCheckpointSaver()
```

### `this.a2a = { ... }`

Set in your service handler's `init()` to customize the default behavior:

| Pattern        | What you provide                   | Plugin provides                         |
| -------------- | ---------------------------------- | --------------------------------------- |
| `{ graph }`    | Compiled LangGraph graph           | Protocol, persistence, agent card, HITL |
| `{ executor }` | Full `AgentExecutor` impl          | Protocol, persistence, agent card       |
| `{ model }`    | LangChain `BaseChatModel` instance | Everything else (zero-code)             |
| _(default)_    | Nothing                            | Everything (zero-code)                  |

#### Custom Model

`this.a2a.model` offers an extension point to overwrite the model that is used by the Plugin. By default, an instance of `OrchestrationClient` for AI Core Access is used. You can pass everything in there that implements LangGraph's `BaseChatModel`. An example with the usage of the local [https://ai-docs.portal.hyperspace.tools.sap/llm-proxy/quickstart/](https://ai-docs.portal.hyperspace.tools.sap/llm-proxy/quickstart/) looks like this:

```js
this.a2a = {
  model: new ChatAnthropic({
    model: "claude-sonnet-4-5",
    anthropicApiKey: "<api-key>",
    anthropicApiUrl: "http://localhost:6655/anthropic",
  }),
}
```

### Human-in-the-Loop (HITL)

For markdown-based agents using `deepagents`, the plugin automatically handles HITL approval flows. When a graph calls `interrupt()` (e.g. via `interruptOn` in `createDeepAgent`), the A2A task transitions to `input-required` and the user is prompted for approval. The user replies with "approve" or "reject" and the graph resumes.

```js
createDeepAgent({
  ...
  interruptOn: {
    createOrder: { allowedDecisions: ["approve", "reject"] }
  },
})
```

No additional plugin configuration needed — interrupt detection, checkpoint persistence, and resume are handled automatically.

Alternatively, HITL can be achieved without `interruptOn` by instructing the agent in its `AGENTS.md` or skills to ask the user for confirmation before proceeding — a pure prompt-based approach with no framework configuration required.

## Samples

- **[Bookshop](./tests/bookshop/)** - Agentifying an existing CAP service. `@a2a` annotation, zero agent code.
- **[Deep Agent](./tests/deep-agent-sample/)** - Building a markdown-based agent. `deepagents` with custom tools, AGENTS.md, and progressive disclosure.
- **[Travel](./tests/travel-sample/)** - Multi-agent system combining both patterns. The orchestrator is a markdown-based deep agent that delegates to agentified CAP services (hotel, activity) via A2A and a flight data service via MCP.

## Tooling

- [A2A Editor](https://github.com/open-resource-discovery/a2a-editor) - Chat UI for A2A agents
- [sem-a2a-cli](https://github.tools.sap/SEM/sem-a2a-cli) - Protocol compliance testing

## Tests

```bash
npm test
```

## License

[Apache License 2.0](./LICENSE)
