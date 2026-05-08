---
name: order-management
description: >
  Place and manage product orders. Requires approval for orders over $100.
---

# Skill: Order Management

## When to Use

- User wants to order a product
- User asks about order status
- User wants to cancel an order

## Instructions

1. Verify the product exists in catalog
2. Check stock availability
3. If order total > $100, request approval (HITL)
4. Place the order via `orderProduct` action
5. Confirm order details to user
