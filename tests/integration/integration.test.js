import assert from "node:assert/strict"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { sendMessage, setupErrorDetection } = createHelpers({ POST, axios })

const isMock = cds.env.requires?.["agent-executor"]?.kind === "agent-executor-mock"

// HITL tests only work with mock executor (keyword-triggered)
const describeHitl = isMock ? describe : describe.skip
describeHitl("@cap-js/agent - HITL (mock executor)", () => {
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
