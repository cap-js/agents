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

## Request Flow

![Request Flow](cap-agents-demo.drawio.svg)

## Running the Sample

Start all three services in separate terminals:

```bash
# Terminal 1 - Flight data (MCP)
cds watch tests/travel-sample/xflights

# Terminal 2 - Hotel + Activity agents (A2A)
cds watch tests/travel-sample/leisure-services

# Terminal 3 - Travel agent orchestrator (A2A)
cds watch tests/travel-sample/travel-agent
```

Then send a message to the travel agent via the A2A protocol at `http://localhost:4004/a2a/travel-agent`.

## Key Concepts

- **Markdown-based orchestrator** - The travel agent uses `createDeepAgent()` with `AGENTS.md` for identity and `skills/` for progressive workflow disclosure. Plugged into CAP via `this.a2a = { graph }`.
- **Agentified CAP services** - Hotels and activities are standard CAP services annotated with `@a2a`. They get their own LLM and tools automatically - no custom code needed.
- **A2A for natural-language delegation** - The orchestrator sends descriptive messages to downstream agents. They handle tool selection and execution independently.
- **MCP for structured tool access** - Flight data is accessed via MCP tools with structured parameters (query, describe, bookFlight, cancelFlight). The orchestrator calls these directly.
- **Multi-turn conversations** - `CdsCheckpointSaver` (auto-injected) persists LangGraph state, enabling multi-turn conversations across requests (plan first, then book).
- **Parallel tool invocation** - The orchestrator calls multiple A2A agents and MCP tools in parallel when the request spans multiple domains.
