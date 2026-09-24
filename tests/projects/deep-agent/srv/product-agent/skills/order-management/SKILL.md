---
name: order-management
description: >
  Place and manage product orders via the orderProduct action.
metadata:
  tags: [orders, products, checkout]
  examples:
    - Order 5 Widget Pro
    - Place an order for 100 Gadget X
    - I want to buy some connectors
---

# Skill: Order Management

## When to Use

- User wants to order a product
- User asks about order status
- User wants to cancel an order

## Instructions

1. Verify the product exists in catalog
2. Check stock availability
3. Place the order via `orderProduct` action
4. Confirm order details to user
