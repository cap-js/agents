# Deep Agent Sample

Markdown-based agent using `deepagents` with `@cap-js/a2a` as runtime. Defines agent identity and behavior in `AGENTS.md`, defines skills in `skills/`, and uses CAP tools + custom logic to interact with a product catalog.

## What the Agent Can Do

- **Search products** by name or category (via CDS `query` tool)
- **Calculate bulk pricing** with tiered volume discounts (custom tool)
- **Place orders** with stock validation (via CDS `orderProduct` action)
- **Progressive disclosure** - reads `AGENTS.md` for identity, loads skills on demand

## Architecture

```
createDeepAgent()
├── model: createDeepAgentModel() - Claude via AI Core
├── tools: CAP-based Tools (query, describe, orderProduct) (CDS) + Custom Tools (calculate_bulk_pricing)
├── memory: AGENTS.md - agent identity and behavior rules
├── skills: product-search/, order-management/ - loaded on demand
├── backend: FilesystemBackend - sandboxed virtual filesystem
└── checkpointer: CdsCheckpointSaver - multi-turn persistence
```

## Running

Requires AI Core credentials:

```bash
cds watch tests/deep-agent-sample
```

Agent endpoint: `http://localhost:4004/a2a/product-agent/`
Agent Card endpoint: `http://localhost:4004/a2a/product-agent/.well-known/agent-card.json`

## Example Prompts

- "Show me all products"
- "How much would 75 Widget Pros cost?"
- "Order 3 Gadget X"
