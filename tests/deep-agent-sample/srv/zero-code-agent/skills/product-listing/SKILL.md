---
name: product-listing
description: >
  List and filter products from the read-only catalog.
metadata:
  tags: [products, listing, read-only]
  examples:
    - Show me every product in the catalog
    - List the cheapest products
    - List products by category
---

# Skill: Product Listing

## When to Use

- User wants a list of available products.
- User wants to filter by price or category.

## Steps

1. Use the `query` tool to read products from the catalog.
2. Render the result as a concise list with name, price, and stock.
