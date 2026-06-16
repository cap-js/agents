---
name: card-override-explicit
description: >
  Hand-crafted agent card for the Card Override sample. Lives outside the
  agent directory and is referenced via the `@a2a.card` annotation.
version: "2.0.0"
defaultInputModes: [text/plain]
defaultOutputModes: [text/plain]
skills:
  - id: catalog-browse
    name: Catalog Browse
    description: Read-only product catalog browsing with explicit card override.
    tags: [products, browse, override]
    examples:
      - Show me all products
      - Find products under $50
      - Browse the catalog
---

# Card Override (Explicit)

This card is defined explicitly in `card-override-agent/cards/card-override.md` and pointed at via
the `@a2a.card` annotation. It overrides both the convention-based skill scan
and any `AGENT_CARD.md` inside the agent directory.
