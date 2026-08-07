> [!WARNING]
> This plugin is in an early experimental state and not recommended for production use.

# @cap-js/agents

CDS plugin for building agents based on the [A2A](https://a2a-protocol.org) protocol.

## Prerequisites

Access to an SAP AI Core instance:

- `AICORE_SERVICE_KEY` environment variable, or
- Bound via `cds bind -2 <instance>`

See [SAP Cloud SDK for AI](https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core) for details.

## Getting Started

```bash
git clone https://github.tools.sap/cap/agent
cd agent && npm i
```

Run the bookshop (zero-code agent):

```bash
cds w tests/samples/bookshop --profile hybrid
```

Send a message:

```bash
curl -s http://localhost:4004/a2a/catalog/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"1","role":"user","parts":[{"kind":"text","text":"Which books do you have?"}]}}}'
```

## Ways to Build Agents

### Agentify Existing CAP Services

Add `@agent` to any CDS service. The plugin auto-generates tools from entities and actions, creates a ReAct agent loop, and serves the service as a remote agent with zero code required. The agent has access to the tools generated from the service model.

```cds
@agent
service CatalogService {
  entity Books as projection on my.Books;
  action submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
```

→ See [Bookshop Sample](./tests/samples/bookshop/)

### Markdown-Based Agents

Define an agent's identity, behaviour, and skills entirely in markdown — no JavaScript handler required. Annotate the CDS service with `@agent` and create a sibling directory matching the slugified service name. The plugin auto-builds the agent at startup.

```cds
@agent
service ProductAgent {
  @readonly entity Products as projection on my.Products;

  @agent.hitl // > Action is considered for Human-in-the-loop
  action doSomething();
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

→ See [Deep Agent Sample](./tests/samples/deep-agent/)

## Configuration

The LLM used by an agent is configured via `cds.requires.llm`. You can provide a `kind` or `impl` as with [any required service](https://cap.cloud.sap/docs/node.js/core-services#required-services) and [connect](https://cap.cloud.sap/docs/node.js/core-services#consuming-services) to it via `cds.connect.to('llm')`.

```jsonc
"cds": {
  "requires": {
    "llm": {
      "kind": "aicore",
      "model": "anthropic--claude-4.6-sonnet"
    }
  }
}
```

| Kind        | Description                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `aicore`    | The default for `production` and `hybrid`, connects to SAP AI Core                                                                      |
| `anthropic` | Used in the `with-claude` profile, autodiscovers config based on environment variables (`ANTHROPIC_API_KEY`) or `.claude/settings.json` |
| `mock`      | The default for `development`, provides a mocked response when called                                                                   |

To use multiple models for different agents, you can define additional ones and reference them via annotation.
When defining an additional model, you need to prefix the kind with `llm-`.

```jsonc
{
  "cds": {
    "requires": {
      "small-llm": {
        // use any name you like
        "kind": "llm-aicore",
        "model": "mistralai--mistral-small",
      },
    },
  },
}
```

```cds
@agent
@agent.llm: 'small-llm'
service CatalogService { ... }
```

| Annotation   | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| `@agent.llm` | LLM service name from `cds.requires` for a single service. Overrides the default (`"llm"`). |

---

> [!WARNING]
> Everything below is advanced / not part of the first official release.
> Their public surface may change.

---

## Advanced Configuration

**Global**

| Setting                          | Description                                                                | Default                  |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| `cds.agents.contentFilter`       | Content filter (`true` = Azure defaults, object = custom, `false` = off)   | `true`                   |
| `cds.agents.pushNotifications`   | Push notifications (`true` = enabled, `false` = disabled, object = config) | `true`                   |
| `cds.agents.mlflow`              | MLflow tracing (`true` or `false`)                                         | `false`                  |
| `cds.agents.per_action_tool`     | One tool per action (vs combined `call`)                                   | `true`                   |
| `cds.agents.trace_langchain`     | Monkey-patch LangChain for tracing                                         | `true`                   |
| `cds.agents.activeUsersInterval` | Schedule for `active_users` metric computation                             | `"24h"` (`0` to disable) |
| `cds.agents.fileIO.enabled`      | Enable A2A file uploads + emissions (see below)                            | `false`                  |

**Per service**

Path-valued annotations are resolved relative to the `.cds` source file.

| Annotation         | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `@agent.directory` | Path to the agent directory (overrides the slug convention). |
| `@agent.card`      | Path to a hand-crafted agent card markdown file.             |

<details>
<summary>Customize Agent Card URL</summary>

If your agent is behind a proxy, configure the agent card URL via `@Core.Links`

```cds
@agent
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

Only available when agentifying existing services with `@agent` annotation.

- **`development`** - Mock LLM.
- **`hybrid` / `production`** - LangGraph ReAct agent with AI Core.

### File I/O

Set `cds.agents.fileIO.enabled = true` to let agents receive uploads and emit files via the A2A protocol.

```jsonc
{
  "cds": {
    "agents": {
      "fileIO": {
        "enabled": true,
        "maxOutputFileSizeBytes": 10485760, // 10 MB cap per emitted file
        "defaultInputModes": ["text/csv"], // overrides advertised MIME types
        "defaultOutputModes": ["text/plain"],
      },
    },
  },
}
```

Sending a file - A2A clients send a `FilePart` (`{ kind: "file", file: { name, mimeType, bytes } }`) and the plugin persists the file and prepends a `[Uploaded files: /uploads/<name> (<mime>, <size>)]` manifest to the user message. It uses `@cap-js/attachments` to persist the files.

### Push Notifications

Agents advertise push notification support via `capabilities.pushNotifications: true` in the agent card. Clients can register a webhook URL to receive task updates as HTTP POST callbacks instead of (or in addition to) SSE streaming.

<details>
<summary>Configuration</summary>

Push notifications are enabled by default. To disable:

```jsonc
{
  "cds": {
    "agents": {
      "pushNotifications": false,
    },
  },
}
```

**Domain allowlist** — restrict which domains are accepted as callback URLs. By default, only `cloud.sap` (and its subdomains) is allowed:

```jsonc
{
  "cds": {
    "agents": {
      "pushNotifications": {
        "allowedDomains": ["cloud.sap", "mycompany.com"],
      },
    },
  },
}
```

When configured, the agent rejects push notification registrations whose callback URL does not match an allowed domain. Subdomains are accepted (e.g. `api.mycompany.com` matches `mycompany.com`). If you need to accept additional domains beyond `cloud.sap`, add them to the `allowedDomains` array.

</details>

## Quota Enforcement

The plugin enforces configurable rate limits and resource quotas at two levels:

1. **Pre-request** — checked before graph execution starts. Returns HTTP `429` with `Retry-After` header.
2. **Per-node** — checked after each LLM iteration inside the graph. Fails the task with `state: "failed"`.

<details>
<summary>Configuration</summary>

All limits are configured via `cds.env.agents.pool` (defaults provided by the plugin):

```json
{
  "cds": {
    "agent": {
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

## Audit Trail

The plugin records immutable audit logs of agent decisions, actions, tool usage, and outcomes via [`@cap-js/audit-logging`](https://github.com/cap-js/audit-logging). All events are emitted as `SecurityEvent` for compatibility with the SAP Audit Log Service.

```bash
npm add @cap-js/audit-logging
```

In development, audit events are logged to the console. In production, they are sent to the SAP Audit Log Service via the transactional outbox.

<details>
<summary>Events</summary>

| Event                  | Trigger                         | Key Fields                                                                                        |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AgentTaskStarted`     | New task submitted              | `taskId`, `contextId`, `service`, `userMessage`                                                   |
| `AgentTaskResumed`     | HITL resume (approve/reject)    | `taskId`, `contextId`, `service`, `decision`, `userMessage`                                       |
| `AgentDecision`        | LLM invocation returns          | `taskId`, `service`, `model`, `iteration`, `toolCalls`, `inputTokens`, `outputTokens`, `duration` |
| `ToolInvocation`       | Tool executed                   | `taskId`, `service`, `tool`, `args`, `outcome`, `result`, `duration`                              |
| `AgentInputRequired`   | Agent requests human approval   | `taskId`, `contextId`, `service`, `description`, `userMessage`                                    |
| `AgentTaskCompleted`   | Task succeeds                   | `taskId`, `contextId`, `service`, `duration`, `tokens`, `toolCalls`, `output`, `task`             |
| `AgentTaskFailed`      | Task fails                      | `taskId`, `contextId`, `service`, `error`, `errorCode`, `task`                                    |
| `AgentTaskCanceled`    | Task canceled                   | `taskId`, `service`                                                                               |
| `QuotaExceeded`        | Quota breach                    | `action`, `service`, `user`, `reason`, `forwardedIp` + `ip` (top-level)                           |
| `ContentFilterBlocked` | Input blocked by content filter | `service`, `user`, `taskId`, `reason`, `source` (`user` or `tool`)                                |

All events include the original event name in the `data` field for filtering and forensic reconstruction. Common fields (`uuid`, `tenant`, `user`, `time`) are auto-filled by `@cap-js/audit-logging`. Every event also carries a `correlationId` (`cds.context.id`) for cross-referencing with auto-emitted DPP events.

</details>

<details>
<summary>Coverage</summary>

| Scenario                                                       | Audit coverage                                                                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in ReAct (`@agent` annotation)                           | Full — all events fire automatically                                                                                                                                         |
| Built-in Skill-based Agent (`@agent` annotation and AGENTS.md) | Full — all events fire automatically                                                                                                                                         |
| Custom graph (`buildGraph` event)                              | Full — task lifecycle, CDS tools, custom tools, and deepagents built-in tools are all covered automatically. LLM decisions covered if `config` carries `_taskId`/`_service`. |

</details>

<details>
<summary>Correlation</summary>

Events are correlated via `taskId`. For custom graphs, set `configurable._taskId` and `configurable._service` in your LangGraph config for full correlation. The plugin also sets `cds.context["agent.task.id"]` and `cds.context["agent.service"]` as fallback.

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

**Privacy:** By default, spans contain only names, IDs, token counts, and outcomes — no message content. Set `DEBUG=agent` (or `cds.log.levels.agent: "debug"`) to include full input/output as `gen_ai.input.messages` and `gen_ai.output.messages` span attributes.

</details>

<details>
<summary>Grafana (local trace + metrics visualization)</summary>

Run [Grafana OTel LGTM](https://github.com/grafana/docker-otel-lgtm) locally for traces, metrics, and logs in one stack:

```bash
podman run -d --name lgtm \
  -p 3000:3000 \
  -p 4318:4318 \
  grafana/otel-lgtm
```

Start the app with OTLP export:

```bash
cds w tests/samples/bookshop --profile hybrid,telemetry
```

The bookshop's `telemetry` profile is preconfigured with OTLP export to `localhost:4318`. Open http://localhost:3000 to browse traces (Tempo) and metrics (Prometheus) in Grafana.

</details>

<details>
<summary>Metrics</summary>

| Metric                        | Type             | Description                                   | Attributes                                          |
| ----------------------------- | ---------------- | --------------------------------------------- | --------------------------------------------------- |
| `agent.requests.total`        | Counter          | Total inbound agent requests                  | `sap.tenantId`, `agent.service`, `agent.method`     |
| `agent.request.duration`      | Histogram (ms)   | End-to-end agent request duration             | `sap.tenantId`, `agent.service`, `agent.method`     |
| `agent.errors.total`          | Counter          | Requests resulting in error                   | `sap.tenantId`, `agent.service`, `agent.error.code` |
| `agent.executions.concurrent` | UpDownCounter    | Currently active workflow executions          | `sap.tenantId`, `agent.service`                     |
| `agent.workflows.completed`   | Counter          | Completed agent workflows                     | `sap.tenantId`, `agent.service`                     |
| `agent_actions`               | Counter          | LLM invocations (agent node calls) per tenant | `sap.tenantId`                                      |
| `agent.llm.input_tokens`      | Counter          | LLM input tokens consumed                     | `sap.tenantId`, `model`, `node`                     |
| `agent.llm.output_tokens`     | Counter          | LLM output tokens generated                   | `sap.tenantId`, `model`, `node`                     |
| `agent.llm.invocations`       | Counter          | LLM invocation count                          | `sap.tenantId`, `model`, `node`, `outcome`          |
| `agent.tool.invocations`      | Counter          | Tool invocation count                         | `sap.tenantId`, `tool`, `outcome`                   |
| `active_users`                | Observable Gauge | Active users per service (24h rolling window) | `sap.tenantId`, `agent.service`                     |

Error codes: `-32603` (JSON-RPC internal error), `execution_failed` (graph error), `timeout` (graph timeout).

All metrics include `sap.tenantId` from `cds.context.tenant` for multi-tenant aggregation.

The `active_users` gauge is computed periodically (default every 24h). To trigger manually:

```js
const { computeActiveUsers } = await import("@cap-js/agents/lib/telemetry/active-users.js")
await computeActiveUsers()
```

Set `cds.agents.activeUsersInterval: 0` to disable automatic scheduling (manual trigger only).

</details>

<details>
<summary>MLflow</summary>

Export traces to [MLflow](https://mlflow.org/docs/latest/llms/tracing/) for GenAI observability. The plugin adds `mlflow.*` span attributes to existing OTel spans so the MLflow OTLP ingestion endpoint assembles them into proper MLflow traces — no additional SDK required.

The MLflow exporter is added as a **second span processor** alongside any existing exporter (Dynatrace, Cloud Logging, Grafana, etc.). Existing telemetry pipelines are not affected.

**Enable:**

```json
{ "cds": { "agent": { "mlflow": true } } }
```

**Set the experiment ID** via `@Core.SchemaVersion` annotation on your service (feature-toggleable):

```cds
@agent
@Core.SchemaVersion: '123456789'
service CatalogService { ... }
```

**Provide credentials** via a BTP user-provided service named `mlflow`:

```bash
cf cups mlflow -p '{"MLFLOW_HOST":"https://mlflow.example.com","MLFLOW_TOKEN":"...","MLFLOW_EXPERIMENT_ID":"123456789"}'
```

Or, for **OAuth client credentials** authentication (recommended for production):

```bash
cf cups mlflow -p '{"url":"https://auth.example.com","clientid":"my-client","clientsecret":"...","MLFLOW_OTLP_ENDPOINT":"https://mlflow.example.com/v1/traces","MLFLOW_EXPERIMENT_ID":"123456789"}'
```

When `clientid`, `clientsecret`, and `url` are present, the plugin uses `@sap-cloud-sdk/connectivity` to fetch and cache OAuth tokens automatically — no manual token rotation required. Falls back to static `MLFLOW_TOKEN` when OAuth credentials are absent.

The `@Core.SchemaVersion` annotation takes precedence over credentials. Since it's a CDS annotation, it can be overridden per feature toggle.

The plugin reads credentials from `cds.env.requires["mlflow"].credentials` and adds a `BatchSpanProcessor` with an OTLP exporter pointed at the MLflow endpoint.

**Credential reference:**

| Key                    | Required | Description                                                                                  |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `MLFLOW_HOST`          | yes¹     | MLflow server URL (e.g. `https://mlflow.example.com`)                                        |
| `MLFLOW_TOKEN`         | yes³     | Static bearer token / personal access token                                                  |
| `clientid`             | yes³     | OAuth client ID                                                                              |
| `clientsecret`         | yes³     | OAuth client secret                                                                          |
| `url`                  | yes³     | OAuth token endpoint base URL                                                                |
| `MLFLOW_EXPERIMENT_ID` | no       | Default MLflow experiment ID (overridden per service by `@Core.SchemaVersion`)               |
| `MLFLOW_OTLP_ENDPOINT` | no       | Full OTLP traces URL — overrides the endpoint derived from `MLFLOW_HOST`                     |
| `UC_CATALOG`           | no²      | Unity Catalog catalog name for UC trace storage (e.g. `main`)                                |
| `UC_SCHEMA`            | no²      | Unity Catalog schema name (e.g. `mlflow_traces`)                                             |
| `UC_TABLE_PREFIX`      | no²      | Table prefix — traces are written to `<UC_CATALOG>.<UC_SCHEMA>.<UC_TABLE_PREFIX>_otel_spans` |

¹ Required unless `MLFLOW_OTLP_ENDPOINT` is set directly.  
² All three UC keys must be set together to enable Unity Catalog trace storage. When set, the `X-Databricks-UC-Table-Name` header is added to every OTLP export request.  
³ Either `MLFLOW_TOKEN` (static token) or `clientid` + `clientsecret` + `url` (OAuth) must be provided. OAuth takes precedence when both are present.

**Span attributes added** (only when `cds.agents.mlflow` is truthy):

| Attribute                | Source                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `mlflow.experimentId`    | `@Core.SchemaVersion` annotation or service credentials                                               |
| `mlflow.traceRequestId`  | `cds.context.id`                                                                                      |
| `mlflow.spanType`        | `AGENT` / `LLM` / `TOOL` / `CHAIN`                                                                    |
| `mlflow.spanInputs`      | Tool args, user message (JSON)                                                                        |
| `mlflow.spanOutputs`     | Agent response (JSON)                                                                                 |
| `mlflow.chat.tokenUsage` | `{input_tokens, output_tokens, total_tokens, cache_read_input_tokens?, cache_creation_input_tokens?}` |
| `mlflow.traceTag.*`      | Session, user, tenant (extracted as trace tags by MLflow server)                                      |

**Local testing with self-hosted MLflow:**

Start an [MLflow OSS](https://mlflow.org/docs/latest/getting-started/quickstart.html) server via container:

```bash
podman run -p 5678:5000 ghcr.io/mlflow/mlflow mlflow server --host 0.0.0.0
```

The bookshop ships with default credentials for `localhost:5678` in the `tracing` profile — no env variables needed. Just enable mlflow:

```bash
cds w tests/samples/bookshop --profile hybrid,tracing
```

Traces appear at http://localhost:5678/#/experiments/0.

</details>

## Content Filter

By default, all LLM calls pass through [SAP AI Core content filtering](https://help.sap.com/docs/sap-ai-core/generative-ai/input-filtering) with Azure Content Safety and a prompt injection shield (`cds.agents.contentFilter: true`). This blocks prompt injection attacks both from user messages and from tool output (e.g. malicious data in database fields).

<details>
<summary>Configuration options</summary>

**Disable globally:**

```json
{ "cds": { "agents": { "contentFilter": false } } }
```

**Custom filter dictionary:**

Azure content safety levels: ALLOW_SAFE -> ALLOW_SAFE_LOW -> ALLOW_SAFE_LOW_MEDIUM -> ALLOW_ALL

```json
{
  "cds": {
    "agents": {
      "contentFilter": {
        "input": {
          "azure_content_safety": {
            "hate": "ALLOW_SAFE_LOW",
            "violence": "ALLOW_SAFE_LOW_MEDIUM",
            "prompt_shield": true
          },
          "llama_guard_3_8b": {
            "violent_crimes": true
          }
        },
        "output": {
          "azure_content_safety": {
            "hate": "ALLOW_SAFE",
            "violence": "ALLOW_SAFE_LOW_MEDIUM"
          }
        }
      }
    }
  }
}
```

**Per-service override** via `buildContentFilter` event handler:

```js
// Disable for one service (return an empty object)
this.on("buildContentFilter", () => ({}))

// Custom filter
this.on("buildContentFilter", () => ({
  input: {
    azure_content_safety: { prompt_shield: true, hate: "ALLOW_SAFE" },
    llama_guard_3_8b: { violent_crimes: true },
  },
  output: {
    azure_content_safety: { hate: "ALLOW_SAFE", violence: "ALLOW_SAFE" },
  },
}))
```

Resolution order: `buildContentFilter` event handler → `cds.env.agents.contentFilter` → default (Azure Content Safety). Return `{}` from the event handler to disable filtering for the service; returning nothing falls through to the global config.

</details>

## Manual graph wiring

For full control, override the `buildGraph` event to provide a compiled LangGraph graph directly. Useful when you need a multi-agent graph, custom checkpointer behaviour, or non-`deepagents` tooling.

```js
import { createDeepAgent, StateBackend } from "deepagents"

export default class MyAgent extends cds.ApplicationService {
  async init() {
    this.on("buildGraph", async () => {
      const { tools } = await this.send("buildTools", {})
      const model = await this.send("buildModel", { deepAgent: true })
      return createDeepAgent({
        model,
        tools,
        memory: ["./AGENTS.md"],
        skills: ["./skills/"],
        backend: new StateBackend(),
        // checkpointer auto-injected by plugin (CdsCheckpointSaver)
      })
    })
    await super.init()
  }
}
```

## Downstream MCP and Agent Connections

> Experimental API. Config may change, please provide feedback.

Connect to other services marked with `@mcp` or `@agent`. Connected services may live in the same app or be connected via [MCP](https://modelcontextprotocol.io) or [A2A](https://a2a-protocol.org/).

Specify the services to connect with `@agent.connect`:

```cds
@agent.connect: [ 'FlightsService', 'HotelsService' ]
@agent service TravelAgent {}
```

Alternatively, connect to every available `@mcp` and `@agent` service:

```cds
@agent.connect: 'auto'
@agent service TravelAgent {}
```

You can also configure it globally for all agents or per service in the cds config:

```json
"cds": {
  "agents": {
    "connect": "none"  // global base configuration for all agents
  },
  "requires": {
    "TravelAgent": {
      "agent": {
        "connect": "auto"  // per service, similar to the annotation
      }
    }
  }
}
```

Options for `agent.connect`:

| Value                       | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `none`                      | No downstream connections to other services           |
| `auto` (default)            | Connect to all available `@mcp` and `@agent` services |
| `mcp`                       | Connect to all available `@mcp` services              |
| `agent`                     | Connect to all available `@agent` services            |
| `[ 'FlightsService', ... ]` | Connect to listed services                            |

If the connected services are served remotely, configure the `cds.requires` entry as usual:

```json
"cds": {
  "requires": {
    "FlightsService": true,
    "HotelsService": "agent",
    "EventsService": {
      "kind": "mcp",
      "credentials": { "url": "..." } // or destinations...
    }
  }
}
```

→ See [Travel Sample](./tests/samples/travel/) for a complete multi-agent orchestration example.

## API

### `contentFilterMiddleware()`

Deep agent middleware that proactively checks user input against content filters without sending the full context. Extracts only the latest human message / tool result and sends it to a cheap model (`gpt-4o-mini`, `max_tokens: 1`) with input filters. If blocked, returns a polite refusal. The main model only runs output filters.

Applied automatically for auto-built deep agents. For custom deep agents:

```js
import { createDeepAgent } from "deepagents"
import { contentFilterMiddleware } from "@cap-js/agents"

const agent = createDeepAgent({
  model: await srv.send("buildModel", { deepAgent: true }),
  tools,
  middleware: [await contentFilterMiddleware()],
})
```

### `CdsCheckpointSaver`

LangGraph `BaseCheckpointSaver` backed by CDS entities. Auto-injected when using `buildGraph`. Exported for custom executors or direct checkpoint access.

```js
import { CdsCheckpointSaver } from "@cap-js/agents"
const checkpointer = new CdsCheckpointSaver()
```

By default, only special checkpoint writes (interrupts, errors, scheduled tasks, resume signals) are persisted. Regular node output writes are skipped to reduce database load — the full graph state is already captured in the checkpoint blob itself. This assumes a **sequential graph** (no fan-out/fan-in parallel branches).

If your application uses a custom graph with parallel branches, enable full write persistence to avoid re-execution of completed branches on resume:

```jsonc
// package.json or .cdsrc.json
"cds": { "agent": { "persistAllCheckpointWrites": true } }
```

### Service Events (CAP Handler Pattern)

Override default behavior by registering event handlers in your service's `init()`. FIFO semantics give app handlers priority over plugin defaults.

All `build*` events are called **once on first request** (lazy initialization), not at server startup. The compiled graph is then cached per feature vector (`cds.context.features`). Different feature combinations produce different cached graphs — enabling feature-toggled agent behavior without restart.

| Event                | Default behavior                                                                                                             | Return type                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `buildGraph`         | Auto deep-agent or ReAct agent from `langchain`. Calls `buildTools`, `buildModel`, `buildSystemPrompt` and `buildMiddleware` | Compiled graph or GraphExecutor  |
| `buildTools`         | Query & describe tool and actions as tool                                                                                    | `Array<tools>`                   |
| `buildModel`         | Customized AI Core Orchestration client. Calls `buildContentFilter`                                                          | LangChain `BaseChatModel`        |
| `buildSystemPrompt`  | `@description` of service                                                                                                    | `string`                         |
| `buildMiddleware`    | Quota enforcement, content filtering, and `agent_actions` metric                                                             | `Array<AgentMiddleware>`         |
| `buildContentFilter` | Checking for prompt injection and harmful content.                                                                           | Filter config or `{}` to disable |

#### Custom Model

Override the LLM model via `buildModel`. Tools are automatically bound after the handler returns.

```js
this.on("buildModel", async () => {
  const { ChatAnthropic } = await import("@langchain/anthropic")
  return new ChatAnthropic({
    model: "claude-sonnet-4-5",
    anthropicApiKey: "<api-key>",
    anthropicApiUrl: "http://localhost:6655/anthropic",
  })
})
```

#### Custom Tools

Override tool generation via `buildTools`. Tools are auto-instrumented (tracing, audit, metrics) via an `after` handler:

```js
// Extend default tools
this.on("buildTools", async (req, next) => {
  const tools = await next()
  tools.push(weatherTool)
  return tools
})
```

### Human-in-the-Loop (HITL)

For markdown-based agents using `deepagents`, the plugin automatically handles HITL approval flows. When a graph calls `interrupt()` (e.g. via `interruptOn` in `createDeepAgent`), the agent task transitions to `input-required` and the user is prompted for approval. The user replies with "approve" or "reject" and the graph resumes.

```js
createDeepAgent({
  ...
  interruptOn: {
    createOrder: { allowedDecisions: ["approve", "reject"] }
  },
})
```

No additional plugin configuration needed — interrupt detection, checkpoint persistence, and resume are handled automatically.

For regular markdown-based agents, `@agent.hitl` will automatically trigger the HITL flow for an action.

## Samples

- **[Bookshop](./tests/samples/bookshop/)** - Agentifying an existing CAP service. `@agent` annotation, zero agent code.
- **[Deep Agent](./tests/samples/deep-agent/)** - Markdown-based agent — convention-driven, with custom tools and skills.
- **[Travel](./tests/samples/travel/)** - Multi-agent system combining both patterns. The orchestrator is a markdown-based deep agent that delegates to agentified CAP services (hotel, activity) and a flight data service via MCP.
- **[Java Bookshop Sidecar](./tests/sidecar-samples/java-bookshop/)** - Agentify a Java CAP app via a Node.js sidecar. Typical for Java: sidecar used in both development and production (similar to `mtx/sidecar`). Start with `cds watch --profile java`.
- **[Node Bookshop Sidecar](./tests/sidecar-samples/node-bookshop/)** - Agentify a Node.js CAP app via a sidecar. This is an unusual setup for Node.js — normally agents run in the same process as the main app. Use the side car option only when the agent must run as a separate process.

## Sidecar Architecture

The sidecar connects to the main CAP app (Java or Node.js) via HCQL. The sidecar profile determines how the connection is set up:

| Profile              | Main App | HCQL path              | Run with                   |
| -------------------- | -------- | ---------------------- | -------------------------- |
| `agent-sidecar,java` | Java     | `/hcql/CatalogService` | `cds watch --profile java` |
| `agent-sidecar,node` | Node.js  | `/hcql/catalog`        | `cds watch`                |

The `java` profile tells the sidecar it is connecting to a Java app. It also enables `_javaHcqlCompat`, which patches action/function calls to use the HCQL envelope format `{"event":"<action>","args":[...]}` required by the Java HCQL adapter. This patch will be removed once the Java HCQL adapter accepts the standard CDS remote format.

<details>
<summary>How the sidecar connects to a Java CAP app</summary>

- the sidecar sees the cds files of the actual application and the services that are annotated with `@agent`
- these services are connected via HCQL — the sidecar acts as a protocol bridge, exposing the Java CAP service as an agent without modifying the Java app

```
Client              Node.js Sidecar                  AI Core (LLM)        Java CAP App
  │                        │                               │                     │
  │─ POST /agent/catalog ─▶│                               │                     │
  │   "what books do       │                               │                     │
  │    you have?"          │                               │                     │
  │                        │ agentProtocolAdapter receives │                     │
  │                        │ message/send request          │                     │
  │                        │                               │                     │
  │                        │── invoke LangGraph ReAct ────▶│                     │
  │                        │   agent with user message     │                     │
  │                        │                               │                     │
  │                        │   ╔═══════════════════════════╧═════════════════╗   │
  │                        │   ║  ReAct loop (repeats until LLM is done)     ║   │
  │                        │   ║                                             ║   │
  │                        │   ║  LLM decides to call a tool                 ║   │
  │                        │◀──╫── tool call (e.g. query, submitOrder)  ─────╢   │
  │                        │   ║                                             ║   │
  │                        │── ╫── HCQL to Java app  ────────────────────────╫──▶│
  │                        │◀──╫── result ───────────────────────────────────╫───│
  │                        │   ║                                             ║   │
  │                        │── ╫── tool result → LLM  ──────────────────────▶╢   │
  │                        │   ║                                             ║   │
  │                        │   ║  LLM decides: call another tool or respond  ║   │
  │                        │   ╚═══════════════════════════╤═════════════════╝   │
  │                        │                               │                     │
  │                        │◀── final response ────────────│                     │
  │                        │    "Here are the books..."    │                     │
  │                        │                               │                     │
  │◀── agent response ─────│                               │                     │
  │    status: completed   │                               │                     │
```

- authentication:
  - when sending a request to the agent, you need to pass the oauth token of the java application
  - this token is given to the sidecar, which passes it on to the java application

```
Client              XSUAA               Node.js Sidecar          Java CAP App
  │                     │                       │                       │
  │─── 1. fetch JWT ───▶│                       │                       │
  │◀── JWT ─────────────│                       │                       │
  │                     │                       │                       │
  │─── 2. POST /agent/catalog ─────────────────▶│                       │
  │       Authorization: Bearer <jwt>           │                       │
  │                     │                       │                       │
  │                     │              3. run LLM + tools               │
  │                     │                       │                       │
  │                     │                       │─── 4. HCQL ──────────▶│
  │                     │                       │    Bearer <jwt>       │
  │                     │                       │◀─── response ─────────│
  │◀── 5. Agent response ───────────────────────│                       │
```

- connecting Sidecar to Java app:

```
Java CAP App                     Node.js Sidecar
  │                                    │
  │  1. Java app starts                │
  │     └─ exposes /hcql/CatalogService│
  │        (via @hcql annotation)      │
  │                                    │  2. Sidecar starts
  │                                    │
  │                                    │  3a. [production] Sidecar reads pre-compiled model
  │                                    │      (bookshop-model.csn.json)
  │                                    │  3b. [development] Sidecar reads model from source
  │                                    │      (../../srv — default for Java apps)
  │                                    │
  │                                    │  4. cds "loaded" event fires
  │                                    │     └─ finds @agent services in model,
  │                                    │     └─ creates cds.requires["<service-name>"]
  │                                    │        { kind: "hcql", credentials: {
  │                                    │  4a.    [production] destination: "srv-api",
  │                                    │                       path: "/<service-name>"
  │                                    │  4b.    [development] url: "http://localhost:8080
  │                                    │                            /hcql/<service-name>"
  │                                    │        } }
  │                                    │
  │                                    │  5. cds "served" event fires, creates Agent for that service
  │                                    │     └─ cds.connect.to("<service-name>")
  │◀─────── HCQL connection ───────────│     └─ mounts POST /agent/<slugified(service-name)> router
```

</details>

<details>
<summary>Limitations of the Sidecar Architecture</summary>

The sidecar mode is designed for applications written in Java. Compared to running the plugin natively in a Node.js CAP app, there are a few constraints to be aware of:

- **HTTP overhead**: every tool call is a remote HCQL round-trip to the main app rather than an in-process call — though this is negligible compared to the LLM call latency.
- **Only HCQL-exposed operations are available**: the sidecar can only call what the Java app exposes as CDS service operations over HCQL — it cannot reach into Java business logic that is not surfaced as a CDS action or entity. **The Java app must have HCQL enabled** (add `cds-adapter-hcql` as a runtime dependency in `pom.xml`). Without it, all agent tool calls fail with a 400 error.
- **Custom executor code must be JavaScript**: if you want a custom LangGraph graph or custom executor logic, that code lives in the Node.js sidecar — there is no way to run custom executor code in the Java app itself. You can use the same `this.agent = { graph }` or `this.agent = { executor }` patterns described in the [Executor Profiles](#executor-profiles) section by adding a CDS service implementation file to the sidecar's `srv/` folder.
- **Task and checkpoint persistence is not tenant-isolated**: the sidecar forwards the incoming JWT to the Java app (so the Java app correctly resolves the tenant), but the sidecar's own HANA schema for `Tasks` and `Checkpoints` is a single shared schema — all tenants' task and checkpoint data lands in the same tables. In a native Node.js CAP app, CDS automatically scopes DB operations to the current tenant; the sidecar has no MTX setup of its own to replicate this. For multi-tenant deployments, either accept this limitation (tasks from different tenants are mixed in one schema) or run a separate sidecar instance per tenant.

</details>

<details>
<summary>Comparison: Native Java implementation vs. Sidecar</summary>

The sidecar approach is a pragmatic bridge: it enables Java CAP applications to expose agents today, without waiting for a native Java implementation of this plugin. The goal is to gather stakeholder feedback and validate the agent programming model with real Java applications.

|                            | Sidecar (now)                                     | Native Java plugin (future)                       |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| **Deployment**             | Separate Node.js process alongside the Java app   | Runs inside the Java CAP app process              |
| **Changes to main app**    | Annotate services with `@agent`, no other changes | Annotate services with `@agent`, no other changes |
| **Tool call execution**    | Remote HCQL round-trip to the Java app            | In-process Java service calls                     |
| **Custom executor/graph**  | JavaScript/TypeScript in the sidecar              | Java in the main app                              |
| **Operational complexity** | Two deployable units                              | One deployable unit                               |
| **Latency**                | Small HCQL overhead, negligible vs. LLM latency   | Minimal                                           |

</details>

## Tooling

- [A2A Editor](https://github.com/open-resource-discovery/a2a-editor) - Chat UI for agents
- [Protocol Docs](https://a2a-protocol.org) - Official protocol specification and guides
- [sem-agent-cli](https://github.tools.sap/SEM/sem-agent-cli) - Protocol compliance testing

## Tests

```bash
npm test
```

## License

[Apache License 2.0](./LICENSE)
