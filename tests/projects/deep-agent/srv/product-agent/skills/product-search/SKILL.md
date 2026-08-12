---
name: product-search
description: >
  Search and browse the product catalog by name, category, or price range.
metadata:
  tags: [products, search, catalog]
  examples:
    - Show me all products
    - Find widgets under $100
    - Search for gadgets
---

# Skill: Product Search

## When to Use

- User asks to find or search products
- User wants to browse the catalog
- User asks about product availability or pricing

## Instructions

1. Use the `describe` tool to understand the Products entity structure
2. Use the `query` tool to search the Products entity
3. Filter by name (partial match) or category
4. Present results in a table format with name, price, and stock
