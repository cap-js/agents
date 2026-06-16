> [!WARNING]
> This plugin is in an early experimental state and not recommended for production use.

# @cap-js/a2a

CDS protocol adapter for the [A2A (Agent-to-Agent)](https://a2a-protocol.org) protocol.

## Prerequisites

Access to an SAP AI Core instance:

- `AICORE_SERVICE_KEY` environment variable, or
- Bound via `cds bind -2 <instance>`

See [SAP Cloud SDK for AI](https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core) for details.

## Getting Started

```bash
git clone https://github.tools.sap/cap/a2a
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

Define an agent's identity, behaviour, and skills entirely in markdown — no JavaScript handler required. Annotate the CDS service with `@a2a` and create a sibling directory matching the slugified service name. The plugin auto-builds the agent at startup.

```cds
@a2a
service ProductAgent {
  @readonly entity Products as projection on my.Products;
}
```

```
srv/
├─ product-agent-service.cds
└─ product-agent/                ← matches the slugified service name
   ├─ AGENTS.md                  ← agent identity + behaviour
   └─ skills/
      └─ catalog-browse/
         └─ SKILL.md             ← workflow + examples
```

`AGENTS.md` defines who the agent is. The frontmatter populates the agent card;
the body is the agent's system prompt:

```md
---
name: product-agent
version: "1.0.0"
description: Read-only product catalog assistant.
---

# Product Agent

You help users find and explore products in the catalog. Use ...
```

→ See [Deep Agent Sample](./tests/deep-agent-sample/)

#### Custom locations: `@a2a.directory` and `@a2a.card`

Two annotations override the convention when your layout doesn't match. Both
paths are resolved relative to the `.cds` file.

| Annotation       | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `@a2a.directory` | Path to the agent directory (overrides the slug convention). |
| `@a2a.card`      | Path to a hand-crafted agent card markdown file.             |

```cds
@a2a
@a2a.directory: 'agents/product'
@a2a.card     : 'cards/product-card.md'
service ProductAgent {
  @readonly entity Products as projection on my.Products;
}
```

---

> [!WARNING]
> Everything below is advanced / not part of the first official release.
> Their public surface may change.

---

## Configuration

| Setting                       | Description                                                              | Default                        |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `cds.a2a.llm`                 | LLM model name                                                           | `anthropic--claude-4.5-sonnet` |
| `cds.a2a.contentFilter`       | Content filter (`true` = Azure defaults, object = custom, `false` = off) | `true`                         |
| `cds.a2a.per_action_tool`     | One tool per action (vs combined `call_action`)                          | `true`                         |
| `cds.a2a.trace_langchain`     | Monkey-patch LangChain for tracing                                       | `true`                         |
| `cds.a2a.activeUsersInterval` | Schedule for `active_users` metric computation                           | `"24h"` (`0` to disable)       |

<details>
<summary>Customize Agent Card URL</summary>

If your agent is behind a proxy, configure the agent card URL via `@Core.Links`

```cds
@a2a
@Core.Links : [
  {
      rel : 'via',
      href : 'https://example.com/agent/catalog',
  },
]
service CatalogService { }
```

</details>

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
        "maxLLMTokensPerDay": 5000000,
        "maxToolCallsPerHour": 1000,
        "maxToolCallsPerTask": 50,
        "maxLLMInvocationsPerTask": 15,
        "maxLLMTokensPerTask": 200000,
        "maxLLMCallTimeoutMs": 120000,
        "maxExecutionTimeMsPerTask": 300000,
        "maxIncomingMessageLength": 5000
      }
    }
  }
}
```

</details>

<details>
<summary>Pre-Request Limits (HTTP 429)</summary>

| Limit                       | Retry-After        | Scope   |
| --------------------------- | ------------------ | ------- |
| `maxConcurrentTasks`        | 30s                | Tenant  |
| `maxConcurrentTasksPerUser` | 30s                | User    |
| `maxTasksPerHour`           | Next hour boundary | Tenant  |
| `maxTasksPerHourPerUser`    | Next hour boundary | User    |
| `maxToolCallsPerHour`       | Next hour boundary | Tenant  |
| `maxLLMTokensPerDay`        | Midnight UTC       | Tenant  |
| `maxIncomingMessageLength`  | — (HTTP 400)       | Request |

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
| `QuotaExceeded`      | Quota breach                  | `action`, `service`, `user`, `reason`, `forwardedIp` + `ip` (top-level)                           |

All events include the original event name in the `data` field for filtering and forensic reconstruction. Common fields (`uuid`, `tenant`, `user`, `time`) are auto-filled by `@cap-js/audit-logging`. Every event also carries a `correlationId` (`cds.context.id`) for cross-referencing with auto-emitted DPP events.

</details>

<details>
<summary>Coverage</summary>

| Scenario                                    | Audit coverage                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in ReAct (`@a2a` annotation)          | Full — all events fire automatically                                                                                                                                         |
| Custom graph (`this.a2a = { graph }`)       | Full — task lifecycle, CDS tools, custom tools, and deepagents built-in tools are all covered automatically. LLM decisions covered if `config` carries `_taskId`/`_service`. |
| Custom executor (`this.a2a = { executor }`) | None — custom executors manage their own lifecycle                                                                                                                           |

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

## Content Filter

By default, all LLM calls pass through [SAP AI Core Azure Content Safety](https://sap.github.io/ai-sdk/docs/js/orchestration/chat-completion#azure-content-filter) with a prompt injection shield (`cds.a2a.contentFilter: true`). This blocks prompt injection attacks both from user messages and from tool output (e.g. malicious data in database fields).

<details>
<summary>Configuration options</summary>

**Disable globally:**

```json
{ "cds": { "a2a": { "contentFilter": false } } }
```

**Custom filter object globally:**

```json
{
  "cds": {
    "a2a": {
      "contentFilter": {
        "input": {
          "filters": [
            { "type": "azure_content_safety", "config": { "hate": 0, "prompt_shield": true } }
          ]
        },
        "output": { "filters": [] }
      }
    }
  }
}
```

**Per-service override** via `this.a2a.contentFilter`:

```js
// Disable for one service
this.a2a = { contentFilter: false }

// Custom filter object
this.a2a = {
  contentFilter: {
    input: { filters: [myCustomFilter] },
    output: { filters: [] },
  },
}

// Async factory function (full control)
this.a2a = {
  contentFilter: async () => {
    const { buildAzureContentSafetyFilter } = await import("@sap-ai-sdk/orchestration")
    const filter = buildAzureContentSafetyFilter("input", { prompt_shield: true })
    return { input: { filters: [filter] }, output: { filters: [] } }
  },
}
```

Resolution order: `srv.a2a.contentFilter` → `cds.env.a2a.contentFilter` → default (Azure Content Safety).

</details>

### Limitations: prompt_shield + large contexts

The default `prompt_shield` filter (Azure Content Safety) has a request payload
size limit. Markdown-based agents accumulate large contexts — system prompt,
skill files, multiple tool results — that can exceed it. The fix for now is to
disable filtering for the affected services.

`contentFilter: false` only takes effect on per-service models if `srv.a2a` is
assigned **before** the model is constructed; the unawaited-Promise pattern
guarantees that ordering:

```js
async function createMyAgent(srv) {
  const model = await createDeepAgentModel({ srv })
  return createDeepAgent({
    model,
    /* ... */
  })
}

export default class MyAgent extends cds.ApplicationService {
  async init() {
    this.a2a = {
      contentFilter: false, // visible by the time createDeepAgentModel reads srv.a2a
      graph: createMyAgent(this), // unawaited Promise
    }
    await super.init()
  }
}
```

If you want to keep the content filter enabled and recover from filter errors
gracefully instead of failing the task, see
[`contentFilterRecoveryMiddleware()`](#contentfilterrecoverymiddleware) in the
API section.

## Manual graph wiring

For full control, plug a compiled LangGraph graph in directly via
`this.a2a = { graph }`. Useful when you need a multi-agent graph, custom
checkpointer behaviour, or non-`deepagents` tooling.

```js
import { createDeepAgent, FilesystemBackend } from "deepagents"
import { createDeepAgentModel, generateTools } from "@cap-js/a2a"

// Extract the async construction so it returns a Promise.
// See "Lazy graph construction" below for why.
async function createMyAgent(srv) {
  const { tools } = generateTools(srv)
  const model = await createDeepAgentModel({ srv })
  return createDeepAgent({
    model,
    tools,
    memory: ["./AGENTS.md"],
    skills: ["./skills/"],
    backend: new FilesystemBackend({
      rootDir: import.meta.dirname + "/my-agent",
      virtualMode: true,
    }),
    // checkpointer auto-injected by plugin (CdsCheckpointSaver)
  })
}

export default class MyAgent extends cds.ApplicationService {
  async init() {
    this.a2a = {
      graph: createMyAgent(this), // unawaited Promise — see "Lazy graph construction"
    }
    await super.init()
  }
}
```

### Lazy graph construction

`srv.a2a.graph` accepts either a compiled LangGraph graph **or** a `Promise<Graph>`. For deepagents and any setup that depends on per-service overrides like `srv.a2a.contentFilter` or `srv.a2a.model`, **prefer the Promise form**: extract an `async function createMyAgent(srv) { … }` and assign `this.a2a = { graph: createMyAgent(this), … }` _without_ `await`.

Why this matters: the right-hand side of `this.a2a = { … }` is fully evaluated **before** the assignment to `this.a2a` commits. If you `await createDeepAgentModel({ srv: this })` inline inside the object literal, the model is built while `this.a2a` is still `undefined`, so per-service overrides like `srv.a2a.contentFilter` and `srv.a2a.model` are silently ignored and fall back to the global `cds.env.a2a.*` defaults. With the unawaited-Promise form, `this.a2a` is assigned synchronously first; the factory's body resumes in a microtask afterwards, by which time `srv.a2a.*` is visible. The plugin's `GraphExecutor` awaits the Promise on first request.

Compiled-graph form (`this.a2a = { graph: alreadyCompiledGraph }`) is also supported, and fine when the graph has no per-service runtime configuration.

## API

### `createDeepAgentModel(options?)`

Creates an LLM model for use with `deepagents`' `createDeepAgent()`. Handles
SAP AI Core's array-content compatibility issue: deepagents' built-in tools
(`read_file`, `ls`, `grep`, …) return content as `[{ type: "text", text: "..." }]`
arrays, but AI Core requires plain strings. This factory enables message
flattening automatically and uses defaults appropriate for deepagents
(`max_tokens: 4096`, `temperature: 0`, no tool binding).

```js
const { createDeepAgentModel } = require("@cap-js/a2a")

const model = await createDeepAgentModel()
const model = await createDeepAgentModel({ params: { max_tokens: 4096, temperature: 0.2 } })
```

### `createModel(options?)`

Creates an LLM model (OrchestrationClient) for **managed agents** (default
langgraph executor or custom graphs). Binds tools and checks `srv.a2a.model`
overrides. For deepagents, use `createDeepAgentModel()` instead.

```js
import { createModel } from "@cap-js/a2a"

// Managed agent mode (binds tools, uses srv for content filter/model override)
const model = await createModel({ srv, tools })
```

### `contentFilterRecoveryMiddleware()`

LangChain agent middleware for use with `createDeepAgent({ middleware: [...] })`
that gracefully recovers from SAP AI Core content filter errors instead of
crashing the task. Add it to your deepagent's middleware chain to keep
`prompt_shield` enabled while still handling filter rejections politely:

```js
import { createDeepAgent } from "deepagents"
import { createDeepAgentModel, contentFilterRecoveryMiddleware } from "@cap-js/a2a"

const agent = createDeepAgent({
  model: await createDeepAgentModel(),
  tools: [
    /* ... */
  ],
  middleware: [await contentFilterRecoveryMiddleware()],
})
```

### `generateTools(srv)`

Generates LangChain tools from a CDS service model. Reuses tool definitions from `@cap-js/mcp`.

```js
import { generateTools } from "@cap-js/a2a"
const { tools } = generateTools(srv)
// tools: [query, describe, ...perActionTools]
```

### `instrumentTools(tools)`

Wraps tools' `.invoke()` with OpenTelemetry tracing, audit logging, and the `a2a.tool.invocations` metric. Use this when you override `.invoke` on a tool instance (e.g., to catch errors for the LLM) — the override bypasses the automatic prototype-level patch.

For standard tools (created via `tool()` or `generateTools()`), instrumentation is automatic — no call needed. The plugin also calls `instrumentTool` on every tool resolved via `srv.a2a.tools`, so you only need it when you build tools outside that resolution path.

```js
import { instrumentTools } from "@cap-js/a2a"

// Pass a list (one or many — mutates and returns the tools)
instrumentTools(mcpTools)
instrumentTools([myMcpTool])

// Typical pattern: instrument first, then wrap with error handling
instrumentTools([mcpTool])
const tracedInvoke = mcpTool.invoke.bind(mcpTool)
mcpTool.invoke = async (args, config) => {
  try {
    return await tracedInvoke(args, config)
  } catch (err) {
    return `Error: ${err.message}`
  }
}
```

Re-throws errors after recording them (unlike CDS tools which swallow errors for LLM retry).

### `CdsCheckpointSaver`

LangGraph `BaseCheckpointSaver` backed by CDS entities. Auto-injected when using `this.a2a = { graph }`. Exported for custom executors or direct checkpoint access.

```js
import { CdsCheckpointSaver } from "@cap-js/a2a"
const checkpointer = new CdsCheckpointSaver()
```

By default, only special checkpoint writes (interrupts, errors, scheduled tasks, resume signals) are persisted. Regular node output writes are skipped to reduce database load — the full graph state is already captured in the checkpoint blob itself. This assumes a **sequential graph** (no fan-out/fan-in parallel branches).

If your application uses a custom graph with parallel branches, enable full write persistence to avoid re-execution of completed branches on resume:

```jsonc
// package.json or .cdsrc.json
"cds": { "a2a": { "persistAllCheckpointWrites": true } }
```

### `this.a2a = { ... }`

Set in your service handler's `init()` to customize the default behavior:

| Pattern             | What you provide                    | Plugin provides                          |
| ------------------- | ----------------------------------- | ---------------------------------------- |
| `{ graph }`         | Compiled LangGraph graph            | Protocol, persistence, agent card, HITL  |
| `{ executor }`      | Full `AgentExecutor` impl           | Protocol, persistence, agent card        |
| `{ model }`         | LangChain `BaseChatModel` instance  | Everything else (zero-code)              |
| `{ tools }`         | Array or factory of LangChain tools | Everything else (zero-code)              |
| `{ contentFilter }` | Filter config, function, or `false` | Overrides global `cds.a2a.contentFilter` |
| _(default)_         | Nothing                             | Everything (zero-code)                   |

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

#### Custom Tools

`this.a2a.tools` replaces or extends the auto-generated CDS tools (`query`, `describe`, per-action). User tools are auto-instrumented (telemetry, audit, metrics).

```js
import { generateTools } from "@cap-js/a2a"

this.a2a = { tools: [weatherTool] }                               // replace
this.a2a = { tools: [...generateTools(this).tools, weatherTool] } // extend
this.a2a = { tools: ({ srv, generateTools }) => [...] }           // factory
```

<details>
<summary>
Notes
</summary>

- Plugin throws at startup if a tool item is missing `name`/`invoke` or if two
  tools share the same name.
- When you supply tools, the plugin does **not** apply `checkAuthorization`
  filtering — your tools are your responsibility. Call `generateTools(srv)`
  (which auth-filters by default) inside your factory to opt back in.
- Empty array (`tools: []`) is allowed: the model runs without function
calling.
</details>

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
- **[Deep Agent](./tests/deep-agent-sample/)** - Markdown-based agent — convention-driven, with custom tools and skills.
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
