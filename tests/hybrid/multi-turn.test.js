/**
 * Multi-turn conversation tests — require hybrid executor (real LLM + checkpointing).
 * Run with: npm run test:hybrid
 */
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
import createHelpers from "../utils/helpers.js"
const { sendMessage, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agents - Multi-turn (hybrid executor)", () => {
  setupErrorDetection()

  it("agent remembers context across turns", async () => {
    const contextId = `mt-test-${Date.now()}`

    const res1 = await sendMessage("catalog", "Tell me about Wuthering Heights", { contextId })
    expect(res1.data.result.status.state).toBe("completed")
    const text1 = res1.data.result.status.message.parts[0].text
    expect(text1).toMatch(/wuthering|brontë|emily/i)
    expect(text1).not.toMatch(/technical issue|not installed|configuration issue/i)

    const res2 = await sendMessage("catalog", "Order 2 copies of that book", { contextId })
    let finalRes = res2

    if (res2.data.result.status.state === "input-required") {
      const taskId = res2.data.result.id
      finalRes = await sendMessage("catalog", "yes", { taskId })
    }

    expect(finalRes.data.result.status.state).toBe("completed")
    const text2 = finalRes.data.result.status.message.parts[0].text
    expect(text2).toMatch(/order|stock|cop/i)
    expect(text2).not.toMatch(/technical issue|not installed|configuration issue/i)
  })
})
