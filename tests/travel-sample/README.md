# Travel Sample

Multi-agent travel planner demonstrating A2A orchestration with MCP tool access. A travel agent coordinates hotel bookings, flight reservations, and local activities by delegating to specialized downstream agents and services.

## Architecture

```mermaid
graph TB
    Client["User / A2A Client"]

    Client -->|"A2A (JSON-RPC)"| TravelAgent

    subgraph "Travel Agent · port 4004"
        TravelAgent["TravelAgentService<br/><i>Custom Executor + LangGraph</i>"]
    end

    subgraph "Activities · port 4006"
        HotelService["HotelService<br/><i>@a2a · default executor</i>"]
        ActivityService["ActivityService<br/><i>@a2a · default executor</i>"]
    end

    subgraph "xflights · port 4005"
        FlightData["sap.capire.flights.data<br/><i>@mcp</i>"]
    end

    TravelAgent -->|A2A| HotelService
    TravelAgent -->|A2A| ActivityService
    TravelAgent -->|MCP| FlightData
```

## Services

| Service         | Port | Protocol | Description                                                                                                               |
| --------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `travel-agent/` | 4004 | `@a2a`   | Orchestrator with custom executor. Connects to downstream A2A agents and MCP server via LangGraph.                        |
| `activities/`   | 4006 | `@a2a`   | Hotel and activity services with default executor. Exposes `HotelService` and `ActivityService` as autonomous A2A agents. |
| `xflights/`     | 4005 | `@mcp`   | Flight master data service. Exposes airlines, airports, flights, and booking actions as MCP tools.                        |

## Request Flow

```mermaid
sequenceDiagram
    participant User
    participant Travel as Travel Agent
    participant LLM
    participant Hotel as HotelService (A2A)
    participant Activity as ActivityService (A2A)
    participant Flights as FlightData (MCP)

    User->>Travel: "Plan a weekend trip to Paris"
    activate Travel

    Travel->>LLM: [SystemMessage, HumanMessage]
    LLM-->>Travel: tool_calls (parallel)

    par describe flight schema
        Travel->>Flights: describe Flights, Airports
        Flights-->>Travel: entity schemas
    and search hotels
        Travel->>Hotel: "Find hotels in Paris..."
        Hotel-->>Travel: hotel options
    and search activities
        Travel->>Activity: "Find activities in Paris..."
        Activity-->>Travel: activity options
    end

    Travel->>LLM: [tool results]
    LLM-->>Travel: tool_calls

    Travel->>Flights: query Airports (Paris)
    Flights-->>Travel: CDG, ORY
    Travel->>Flights: query Flights
    Flights-->>Travel: flight schedules + prices

    Travel->>LLM: [tool results]
    LLM-->>Travel: trip plan (no tool calls)
    Travel-->>User: Weekend plan with options

    deactivate Travel

    User->>Travel: "Book it for Simon Engel"
    activate Travel
    Note over Travel: checkpoint loaded

    Travel->>LLM: [restored history + new message]
    LLM-->>Travel: tool_calls (parallel)

    par book flights
        Travel->>Flights: bookFlight (outbound)
        Flights-->>Travel: confirmed
        Travel->>Flights: bookFlight (return)
        Flights-->>Travel: confirmed
    and book hotel
        Travel->>Hotel: "Book Le Marais Grand Hotel..."
        Hotel-->>Travel: confirmed
    and book activities
        Travel->>Activity: "Book Pastry Class..."
        Activity-->>Travel: confirmed
        Travel->>Activity: "Book Wine Tour..."
        Activity-->>Travel: confirmed
    end

    Travel->>LLM: [booking confirmations]
    LLM-->>Travel: itinerary summary (no tool calls)
    Travel-->>User: All booked!

    deactivate Travel
```

## Running the Sample

Start all three services in separate terminals:

```bash
# Terminal 1 — Flight data (MCP)
cds watch tests/travel-sample/xflights

# Terminal 2 — Hotel + Activity agents (A2A)
cds watch tests/travel-sample/activities

# Terminal 3 — Travel agent orchestrator (A2A)
cds watch tests/travel-sample/travel-agent
```

Then send a message to the travel agent via the A2A protocol at `http://localhost:4004/a2a/travel-agent`.

## Key Concepts

- **Custom executor** — The travel agent sets `this.a2a = { executor }` in its service handler, bypassing the default LangGraph executor with a fully custom implementation.
- **A2A for natural-language delegation** — Hotels and activities are autonomous agents with their own LLM. The orchestrator sends them descriptive messages and they handle tool selection and execution independently.
- **MCP for structured tool access** — Flight data is accessed via MCP tools with structured parameters (query, describe, bookFlight, cancelFlight). The orchestrator calls these directly.
- **Multi-turn conversations** — `CdsCheckpointSaver` persists LangGraph state to the database, enabling multi-turn conversations across requests (plan first, then book).
- **Parallel tool invocation** — The orchestrator calls multiple A2A agents and MCP tools in parallel when the request spans multiple domains.
