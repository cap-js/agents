/**
 * Product Agent — Zero-code-with-tool-override example for @cap-js/agent.
 *
 * Demonstrates the *minimal handler* pattern for deep agents:
 *  - The CDS service is annotated with `@agent` only.
 *    The slug `product-agent` matches the sibling directory
 *    `./product-agent/`, so the plugin auto-resolves the agent dir, builds a
 *    `deepagent` from `AGENTS.md`+`skills/`
 *  - This handler only customises tools (adds a business-logic tool to the
 *    auto-generated CDS tools).
 *  - No `createDeepAgent`, `FilesystemBackend`, `createDeepAgentModel`, or
 *    `agentDir` boilerplate — all auto-derived by the plugin.
 *
 * Run with: cds watch tests/deep-agent-sample
 */
import cds from "@sap/cds"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { generateTools } from "@cap-js/agent"

export default class ProductAgentService extends cds.ApplicationService {
  async init() {
    // Tool override: extend auto-generated CDS tools (query, describe,
    // orderProduct) with a custom business-logic tool. The plugin's
    // auto-deepagent picks `srv.agent.tools` up via `resolveTools(srv)`.
    this.agent = {
      tools: ({ srv }) => [...generateTools(srv).tools, calculateBulkPricing],
    }

    this.on("orderProduct", async (req) => {
      const { productName, quantity } = req.data
      const { Products } = this.entities

      const [product] = await SELECT.from(Products)
        .where({ name: { like: `%${productName}%` } })
        .limit(1)

      if (!product) return `Product "${productName}" not found in catalog.`
      if (product.stock < quantity) {
        return `Insufficient stock for ${product.name}. Requested: ${quantity}, Available: ${product.stock}.`
      }

      const total = (Number(product.price) * quantity).toFixed(2)
      await UPDATE(Products, product.ID).set({ stock: product.stock - quantity })

      return `Order confirmed: ${quantity}x ${product.name} at $${product.price}/unit. Total: $${total}. Remaining stock: ${product.stock - quantity}.`
    })

    await super.init()
  }
}

const calculateBulkPricing = tool(
  async ({ productName, quantity }) => {
    const { Products } = cds.entities("sample.products")
    const results = await SELECT.from(Products)
      .where({ name: { like: `%${productName}%` } })
      .limit(1)
    const product = results[0]
    if (!product) return `Product "${productName}" not found in catalog.`

    let discount = 0
    if (quantity >= 100) discount = 0.25
    else if (quantity >= 50) discount = 0.15
    else if (quantity >= 10) discount = 0.05

    const unitPrice = Number(product.price)
    const discountedPrice = unitPrice * (1 - discount)
    const total = discountedPrice * quantity

    return JSON.stringify({
      product: product.name,
      quantity,
      unitPrice: unitPrice.toFixed(2),
      discount: `${(discount * 100).toFixed(0)}%`,
      discountedUnitPrice: discountedPrice.toFixed(2),
      total: total.toFixed(2),
      tier:
        discount === 0
          ? "standard"
          : quantity >= 100
            ? "enterprise"
            : quantity >= 50
              ? "bulk"
              : "volume",
      stock: product.stock,
      inStock: product.stock >= quantity,
    })
  },
  {
    name: "calculate_bulk_pricing",
    description:
      "Calculate pricing for a bulk product order. Applies volume discounts: " +
      "10+ units = 5% off, 50+ = 15% off, 100+ = 25% off. " +
      "Returns full price breakdown with discount tier and stock availability.",
    schema: z.object({
      productName: z.string().describe("Product name or partial name to search for"),
      quantity: z.number().describe("Number of units to order"),
    }),
  },
)
