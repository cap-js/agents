# Telemetry

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

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
       ├─ chat anthropic--claude-4.6-sonnet
       ├─ execute_tool DynamicStructuredTool query
       ├─ chat anthropic--claude-4.6-sonnet
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
cds w tests/projects/bookshop --profile hybrid,telemetry
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
{ "cds": { "agents": { "mlflow": true } } }
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
cds w tests/projects/bookshop --profile hybrid,tracing
```

Traces appear at http://localhost:5678/#/experiments/0.

</details>
