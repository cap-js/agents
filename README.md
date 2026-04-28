> [!WARNING]
> This plugin is in an early experimental state and not recommended for production use.

# @cap-js/a2a

CDS protocol adapter for the [A2A (Agent-to-Agent)](https://a2a-protocol.org) protocol.

Annotate a CDS service with `@a2a` and it becomes a discoverable AI agent that other agents (or humans) can interact with via the A2A protocol.

## Prerequisites

### AI Core Access

Access to an AI Core instance via one of the following options:

- `AICORE_SERVICE_KEY` set to your AI Core credentials in the environment variables
- Application bound to an AI Core instance, e.g. via `cds bind -2 <srv-instance>` locally

For more information, refer to the [SAP Cloud SDK for AI](https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core).

> [!NOTE]
> In development profile, a mock executor is used that does not require AI Core access. See [Configuration](#configuration).

### Clone the repository and install the samples

```bash
git clone https://github.tools.sap/cap/a2a
cd a2a
npm i
```

As the A2A plugin is reusing the tools from the MCP Adapter, make sure you are using the internal artifactory and install the dependencies:

```bash
npm set @cap-js:registry=https://int.repositories.cloud.sap/artifactory/api/npm/build-releases-npm/
npm i
```

## Serving Agents

Annotate a CDS service with `@a2a`:

```cds
@a2a
service CatalogService {
  @readonly entity Books as projection on my.Books;
  action submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
```

Start the bookshop sample:

```bash
cds w tests/bookshop --profile hybrid
```

Send a request to the agent:

```bash
curl -s http://localhost:4004/a2a/catalog/ \
  -H 'Content-Type: application/json' \
  -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "L1-001",
      "role": "user",
      "parts": [{ "kind": "text", "text": "Which books do you have in stock?" }]
    }
  }
}'
```

## Configuration

### LLM Model

The LLM model is configurable via `cds.env.a2a.llm` or the `AICORE_MODEL` environment variable. Defaults to `anthropic--claude-4.5-sonnet`.

```json
{ "cds": { "a2a": { "llm": "anthropic--claude-4.5-sonnet" } } }
```

### Executor Profiles

The plugin ships two executor implementations:

- **`development`**: Mock executor. Returns sample data from the first entity. No LLM or AI Core needed.
- **`hybrid`, `production`**: LangGraph executor with ReAct agent with LLM, tool calling, and checkpoint persistence. Requires AI Core.

## Behind the Scenes

The plugin does the following in the background:

- Creates a ReAct graph (Reason and Act) with tools auto-generated from the CDS model. These tools are shared with the [CAP MCP Adapter](https://github.tools.sap/cap/mcp-adapter):
  - `describe`: describes the data model of the service
  - `query`: retrieves data from exposed entities
  - One tool per unbound action or function
- Serves the A2A agent card at `GET /.well-known/agent-card.json`
- Exposes the A2A JSON-RPC endpoint at `POST /` (handled by `@a2a-js/sdk`)
- Persists A2A tasks and LangGraph checkpoints for multi-turn conversations

## Custom Executors

For advanced use cases, you can override the default executor by setting `this.a2a = { executor }` in your service handler:

```js
const { CdsCheckpointSaver } = require("@cap-js/a2a")

module.exports = class MyService extends cds.ApplicationService {
  async init() {
    this.a2a = { executor: new MyCustomExecutor(this) }
    await super.init()
  }
}
```

See the [Travel Sample](./tests/travel-sample/) for a full example of a custom orchestrator that coordinates multiple A2A agents and MCP servers.

## Samples

- [Bookshop](./tests/bookshop/): Basic agent. Shows the zero-code setup: annotate with `@a2a` and go.
- [Travel Sample](./tests/travel-sample/): Multi-agent sample. Custom executor coordinating hotels (A2A), local activities (A2A), and flights (MCP).

## Tests

```bash
npm run test
```

## Tooling

- [sem-a2a-cli](https://github.tools.sap/SEM/sem-a2a-cli) for testing A2A protocol compatibility
- [A2A Editor](https://github.com/open-resource-discovery/a2a-editor) for a chat UI to communicate with agents

## License

This package is provided under the terms of the [Apache License 2.0](./LICENSE).
