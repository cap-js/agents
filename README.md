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

| Setting                   | Description                                     | Default                        |
| ------------------------- | ----------------------------------------------- | ------------------------------ |
| `cds.a2a.llm`             | LLM model name                                  | `anthropic--claude-4.5-sonnet` |
| `cds.a2a.per_action_tool` | One tool per action (vs combined `call_action`) | `true`                         |

### Executor Profiles

Only available when agentifying existing services with `@a2a` annotation.

- **`development`** - Mock executor. No LLM needed.
- **`hybrid` / `production`** - LangGraph ReAct agent with AI Core.

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

Set in your service handler's `init()` to override the default executor:

| Pattern        | What you provide          | Plugin provides                         |
| -------------- | ------------------------- | --------------------------------------- |
| `{ graph }`    | Compiled LangGraph graph  | Protocol, persistence, agent card, HITL |
| `{ executor }` | Full `AgentExecutor` impl | Protocol, persistence, agent card       |
| _(default)_    | Nothing                   | Everything (zero-code)                  |

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
