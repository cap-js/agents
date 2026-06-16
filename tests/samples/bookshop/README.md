# Bookshop Sample

Zero-code agent. Annotate with `@agent` - the plugin generates tools, agent card, and ReAct loop automatically.

## What the Agent Can Do

- **Query** books, genres, currencies from the catalog
- **Submit orders** for books (with stock validation)
- **Get stock** levels for specific books

## Running

```bash
cds w tests/samples/bookshop --profile hybrid
```

Agent endpoint: `http://localhost:4004/a2a/catalog/`

Agent card: `http://localhost:4004/a2a/catalog/.well-known/agent-card.json`
