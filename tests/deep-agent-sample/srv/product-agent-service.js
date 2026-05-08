/**
 * Product Agent — Deep agent example for @cap-js/a2a.
 *
 * Demonstrates the full pattern for building agents with:
 * - createDeepAgent() from deepagents library
 * - createDeepAgentModel() from @cap-js/a2a (handles AI Core compatibility)
 * - CDS-derived tools (query, describe, orderProduct) from the plugin
 * - Custom business logic tool (calculate_bulk_pricing)
 * - CdsCheckpointSaver auto-injected by the plugin for multi-turn conversations
 * - this.a2a = { graph } to plug into the A2A protocol adapter
 *
 * Run with: cds bind --exec -- cds watch tests/deep-agent-sample
 */
const cds = require("@sap/cds")
const path = require("path")
const { createDeepAgent, FilesystemBackend } = require("deepagents")
const { tool } = require("@langchain/core/tools")
const { z } = require("zod")
const { createDeepAgentModel, generateTools } = require("@cap-js/a2a")

const LOG = cds.log("product-agent")
const __agentDir = path.join(__dirname, "product-agent")

// createDeepAgentModel() handles the AI Core array-content compatibility
// issue automatically
const model = createDeepAgentModel({ params: { max_tokens: 4096, temperature: 0.2 } })

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

async function createAgent(srv) {
  // Generate CDS-derived tools (query, describe, orderProduct)
  // skipAuth: true because we generate tools at startup (no request context yet) -> Revisit
  const { tools: cdsTools } = generateTools(srv, { skipAuth: true })
  LOG.info("CDS tools generated", { tools: cdsTools.map((t) => t.name) })

  LOG.info("Creating deep agent", { agentDir: __agentDir })

  const agent = createDeepAgent({
    model,
    tools: [...cdsTools, calculateBulkPricing],
    memory: ["./AGENTS.md"],
    skills: ["./skills/"],
    backend: new FilesystemBackend({ rootDir: __agentDir, virtualMode: true }),
  })

  LOG.info("Deep agent created")
  return agent
}

module.exports = class ProductAgentService extends cds.ApplicationService {
  async init() {
    await super.init()

    this.a2a = { graph: createAgent(this) }

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

      // Place order (decrement stock)
      const total = (Number(product.price) * quantity).toFixed(2)
      await UPDATE(Products, product.ID).set({ stock: product.stock - quantity })

      return `Order confirmed: ${quantity}x ${product.name} at $${product.price}/unit. Total: $${total}. Remaining stock: ${product.stock - quantity}.`
    })
  }
}
