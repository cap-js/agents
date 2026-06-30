/**
 * Hybrid test: verifies agent_actions metric fires per LLM invocation
 * for both the react agent (bookshop/CatalogService) and deep agent (product-agent).
 *
 * Run with: npm run test:hybrid
 */
import assert from "node:assert/strict"
import cds from "@sap/cds"
import { captured, setup, teardown, resetCapture, flushMetrics } from "../utils/telemetry-utils.js"
import createHelpers from "../utils/helpers.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/deep-agent")

let canLoad = true
try {
  await import("deepagents")
} catch {
  canLoad = false
}

describe(
  "@cap-js/agents - agent_actions metric (deep agent, per LLM call)",
  { skip: !canLoad },
  () => {
    let sendMessage
    after(teardown)

    before(async () => {
      const helpers = createHelpers({ POST, axios })
      sendMessage = helpers.sendMessage
    })

    beforeEach(resetCapture)

    it("should emit agent_actions metric when deep agent invokes LLM", async () => {
      await sendMessage("product-agent", "List all products")
      const output = await flushMetrics()
      assert.match(
        output,
        /agent_actions/,
        "agent_actions metric should fire per LLM call in deep agent",
      )
    })

    it("should emit agent_actions multiple times for multi-step deep agent tasks", async () => {
      resetCapture()
      // Prompt that requires tool usage → multiple LLM calls (plan + execute + summarize)
      await sendMessage(
        "product-agent",
        "Show me all products and then calculate bulk pricing for 10 units of Widget Pro",
      )
      const output = await flushMetrics()
      // Count occurrences — at minimum 1, typically >1 for multi-step
      const matches = output.match(/agent_actions/g)
      assert.ok(matches, "agent_actions metric should appear in output")
      assert.ok(
        matches.length >= 1,
        `expected at least 1 agent_actions emission, got ${matches.length}`,
      )
    })
  },
)
