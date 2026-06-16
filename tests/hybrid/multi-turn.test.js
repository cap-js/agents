/**
 * Multi-turn conversation tests — require hybrid executor (real LLM + checkpointing).
 * Run with: npm run test:hybrid
 */
import assert from "node:assert/strict"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { sendMessage, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agent - Multi-turn (hybrid executor)", () => {
  setupErrorDetection()

  it("agent remembers context across turns", async () => {
    const contextId = `mt-test-${Date.now()}`

    const res1 = await sendMessage("catalog", "Tell me about Wuthering Heights", { contextId })
    assert.strictEqual(res1.data.result.status.state, "completed")
    const text1 = res1.data.result.status.message.parts[0].text
    assert.match(text1, /wuthering|brontë|emily/i)
    assert.doesNotMatch(text1, /technical issue|not installed|configuration issue/i)

    const res2 = await sendMessage("catalog", "Order 2 copies of that book", { contextId })
    assert.strictEqual(res2.data.result.status.state, "completed")
    const text2 = res2.data.result.status.message.parts[0].text
    assert.match(text2, /order|stock|cop/i)
    assert.doesNotMatch(text2, /technical issue|not installed|configuration issue/i)
  })
})
