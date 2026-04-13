> [!WARNING]
> This plugin is in an early alpha state and not recommended for production use.

# @cap-js/a2a

CDS protocol adapter for the [A2A (Agent-to-Agent)](https://a2a-protocol.org) protocol.

Annotate a CDS service with `@a2a` and it becomes a discoverable AI agent that other agents (or humans) can interact with via the A2A protocol.

## Usage

```cds
@a2a
service CatalogService {
  @readonly entity Books as projection on my.Books;
  action submitOrder(book: Books:ID, quantity: Integer) returns { stock: Integer };
}
```

## Future outlook

- "Agentify" existing CAP Services:
  - `@a2a` annotation on service level, Agent is modelled as the service itself
  - Skills of the agent (also included in Agent Card): `Query`-Skill to get data, one skill for each action/function
- Creating new agents:
  - mainly as Markdown based agents
  - Still the creation of a CAP Service is needed to specify which entities/actions/functions are exposed to the agent as tools (if MD files specify skills, none will be added to the agent card automatically by the plugin)
  - developers creates a directory that contains the AGENT.md and a skills dir
  - Propably use `deepagents`, but also check other possibilities
- Both have:
  - Auto-generation of agent card (from CAP Service or md files, Examples for Skills from Doc comments)
  - Compilation of the agent card during design time (probably needed for ORD integration)
  - Tools of the agent: `query` for entity read, `describe` to discover the CAP service capabilities, `call_action` for actions and functions (or per-action/function tools) => check whether these could be reused / combined with tools from @cap-js/mcp
  - Human-in-the-loop approval for actions (not for functions)
  - Integration of downstram MCP servers as tools with auth propagation
  - Integration of downstream Agents as tools (=> multi-agent setups) with auth propagation
  - Options for overrides (e.g. custom Graph, custom Executor) for complex use cases that still want to benefit from the rest of the infrastructure

## Current Functionality

- Annotating a CDS service with `@a2a` makes it discoverable as an agent via the A2A protocol with automatic creation of the agent card based on the service definition.

## Tests

```bash
npm run test
```

## License

This package is provided under the terms of the [Apache License 2.0](./LICENSE).
