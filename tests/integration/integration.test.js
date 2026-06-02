import assert from "node:assert/strict"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../bookshop")
import createHelpers from "./helpers.js"
const { sendMessage, setupErrorDetection } = createHelpers({ POST, axios })

const isMock = cds.env.requires?.["a2a-executor"]?.kind === "a2a-executor-mock"

// HITL tests only work with mock executor (keyword-triggered)
const describeHitl = isMock ? describe : describe.skip
describeHitl("@cap-js/a2a - HITL (mock executor)", () => {
  setupErrorDetection()

  it("returns input-required when message contains 'hitl'", async () => {
    const res = await sendMessage("catalog", "I need hitl approval")
    assert.notStrictEqual(res.data.result, undefined)
    assert.strictEqual(res.data.result.status.state, "input-required")
    assert.ok(res.data.result.status.message.parts[0].text.includes("approval"))
  })

  it("resumes and completes when approved", async () => {
    const hitlRes = await sendMessage("catalog", "Please approve this hitl action")
    assert.strictEqual(hitlRes.data.result.status.state, "input-required")
    const taskId = hitlRes.data.result.id

    const approveRes = await sendMessage("catalog", "yes", { taskId })
    assert.strictEqual(approveRes.data.result.status.state, "completed")
    assert.ok(approveRes.data.result.status.message.parts[0].text.includes("approved"))
  })

  it("resumes and cancels when rejected", async () => {
    const hitlRes = await sendMessage("catalog", "Submit order that needs hitl")
    assert.strictEqual(hitlRes.data.result.status.state, "input-required")
    const taskId = hitlRes.data.result.id

    const rejectRes = await sendMessage("catalog", "no", { taskId })
    assert.strictEqual(rejectRes.data.result.status.state, "canceled")
    assert.ok(rejectRes.data.result.status.message.parts[0].text.includes("canceled"))
  })
})

// Multi-turn tests only work with hybrid executor (needs checkpointing + real LLM)
const describeMultiTurn = isMock ? describe.skip : describe
describeMultiTurn("@cap-js/a2a - Multi-turn (hybrid executor)", () => {
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
