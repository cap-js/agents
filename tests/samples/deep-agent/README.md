# Deep Agent Sample

Markdown-based agent using `deepagents` with `@cap-js/agents` as runtime. Defines agent identity and behavior in `AGENTS.md`, defines skills in `skills/`, and uses CAP tools + custom logic to interact with a product catalog.

## What the Agent Can Do

- **Search products** by name or category (via CDS `query` tool)
- **Calculate bulk pricing** with tiered volume discounts (custom tool)
- **Place orders** with stock validation (via CDS `orderProduct` action)
- **HITL approval** — when `interruptOn` is configured, orders pause for user approval before execution
- **Progressive disclosure** — reads `AGENTS.md` for identity, loads skills on demand

## Architecture

```
createDeepAgent()
├── model: createModel({ deepAgent: true }) - Claude via AI Core
├── tools: CAP-based Tools (query, describe, orderProduct) (CDS) + Custom Tools (calculate_bulk_pricing)
├── memory: AGENTS.md - agent identity and behavior rules
├── skills: product-search/, order-management/ - loaded on demand
├── backend: FilesystemBackend - sandboxed virtual filesystem
└── checkpointer: CdsCheckpointSaver - multi-turn persistence
```

## Running

Requires AI Core credentials:

```bash
cds watch tests/samples/deep-agent
```

Agent endpoint: `http://localhost:4004/a2a/product-agent/`
Agent Card endpoint: `http://localhost:4004/a2a/product-agent/.well-known/agent-card.json`

## Example Prompts

- "Show me all products"
- "How much would 75 Widget Pros cost?"
- "Order 3 Gadget X"
