# Travel Sample

Multi-agent travel planner demonstrating A2A orchestration with MCP tool access. A travel agent coordinates hotel bookings, flight reservations, and local activities by delegating to specialized downstream agents and services.

## Architecture

![Architecture](cap-agents-demo.drawio.svg)

## Services

| Service             | Port | Protocol | Description                                                                                                     |
| ------------------- | ---- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `travel-agent/`     | 4004 | `@a2a`   | Markdown-based deep agent orchestrator. Delegates to downstream A2A agents and MCP servers via `deepagents`.    |
| `leisure-services/` | 4006 | `@a2a`   | Agentified CAP services. Exposes `HotelService` and `ActivityService` as autonomous A2A agents with LLM access. |
| `xflights/`         | 4005 | `@mcp`   | Flight master data service. Exposes airlines, airports, flights, and booking actions as MCP tools.              |

## Running the Sample

Start all three services in separate terminals:

```bash
# Terminal 1 - Flight data (MCP)
cds watch tests/travel-sample/xflights

# Terminal 2 - Hotel + Activity agents (A2A)
cds watch tests/travel-sample/leisure-services (--profile hybrid)

# Terminal 3 - Travel agent orchestrator (A2A)
cds watch tests/travel-sample/travel-agent
```

The leisure-services can be started in hybrid mode if an AI Core binding is available or the `$AICORE_SERVICE_KEY` environment variable is set. If it is started in development mode, the agents will return a mock response instead of calling an LLM. The travel-agent is always using LLMs, as it has a custom agent implementation. Xflights does not need an LLM to start MCP servers, so the profile does not matter.

Then send a message to the travel agent via the A2A protocol at `http://localhost:4004/a2a/travel-agent`.

## Key Concepts

- **Markdown-based orchestrator** - The travel agent uses `createDeepAgent()` with `AGENTS.md` for identity and `skills/` for progressive workflow disclosure. Plugged into CAP via `this.a2a = { graph }`.
- **Agentified CAP services** - Hotels and activities are standard CAP services annotated with `@a2a`. They get their own LLM and tools automatically - no custom code needed.
- **A2A for natural-language delegation** - The orchestrator sends descriptive messages to downstream agents. They handle tool selection and execution independently.
- **MCP for structured tool access** - Flight data is accessed via MCP tools with structured parameters (query, describe, bookFlight, cancelFlight). The orchestrator calls these directly.
- **Multi-turn conversations** - `CdsCheckpointSaver` (auto-injected) persists LangGraph state, enabling multi-turn conversations across requests (plan first, then book).
- **Parallel tool invocation** - The orchestrator calls multiple A2A agents and MCP tools in parallel when the request spans multiple domains.
