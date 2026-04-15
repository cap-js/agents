const cds = require("@sap/cds")
const { POST, axios } = cds.test(__dirname + "/../bookshop")
const { sendMessage, setupErrorDetection } = require("./helpers")({ POST, axios })

const isMock = cds.env.requires?.["a2a-executor"]?.kind === "a2a-executor-mock"

// HITL tests only work with mock executor (keyword-triggered)
const describeHitl = isMock ? describe : describe.skip
describeHitl("@cap-js/a2a - HITL (mock executor)", () => {
  setupErrorDetection()

  test("returns input-required when message contains 'hitl'", async () => {
    const res = await sendMessage("catalog", "I need hitl approval")
    expect(res.data.result).toBeDefined()
    expect(res.data.result.status.state).toBe("input-required")
    expect(res.data.result.status.message.parts[0].text).toContain("approval")
  })

  test("resumes and completes when approved", async () => {
    const hitlRes = await sendMessage("catalog", "Please approve this hitl action")
    expect(hitlRes.data.result.status.state).toBe("input-required")
    const taskId = hitlRes.data.result.id

    const approveRes = await sendMessage("catalog", "yes", { taskId })
    expect(approveRes.data.result.status.state).toBe("completed")
    expect(approveRes.data.result.status.message.parts[0].text).toContain("approved")
  })

  test("resumes and cancels when rejected", async () => {
    const hitlRes = await sendMessage("catalog", "Submit order that needs hitl")
    expect(hitlRes.data.result.status.state).toBe("input-required")
    const taskId = hitlRes.data.result.id

    const rejectRes = await sendMessage("catalog", "no", { taskId })
    expect(rejectRes.data.result.status.state).toBe("canceled")
    expect(rejectRes.data.result.status.message.parts[0].text).toContain("canceled")
  })
})

// Multi-turn tests only work with hybrid executor (needs checkpointing + real LLM)
const describeMultiTurn = isMock ? describe.skip : describe
describeMultiTurn("@cap-js/a2a - Multi-turn (hybrid executor)", () => {
  setupErrorDetection()

  test("agent remembers context across turns", async () => {
    const contextId = `mt-test-${Date.now()}`

    const res1 = await sendMessage("catalog", "Tell me about Wuthering Heights", { contextId })
    expect(res1.data.result.status.state).toBe("completed")
    const text1 = res1.data.result.status.message.parts[0].text
    expect(text1).toMatch(/wuthering|brontë|emily/i)
    expect(text1).not.toMatch(/technical issue|not installed|configuration issue/i)

    const res2 = await sendMessage("catalog", "Order 2 copies of that book", { contextId })
    expect(res2.data.result.status.state).toBe("completed")
    const text2 = res2.data.result.status.message.parts[0].text
    expect(text2).toMatch(/order|stock|cop/i)
    expect(text2).not.toMatch(/technical issue|not installed|configuration issue/i)
  })
})
