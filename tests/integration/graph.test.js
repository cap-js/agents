const cds = require("@sap/cds")

// deepagents has ESM-only transitive deps (p-retry) that can't be require()'d in Jest.
// Skip these tests until we switch to a vitest runner or configure ESM transforms.
let canLoad = true
try {
  require("deepagents")
} catch {
  canLoad = false
}

const describeGraph = canLoad ? describe : describe.skip

describeGraph("@cap-js/a2a - Custom Graph (deepagents)", () => {
  const { POST, axios } = cds.test(__dirname + "/../deep-agent-sample")
  const { sendMessage, jsonrpc, setupErrorDetection } = require("./helpers")({ POST, axios })

  setupErrorDetection()

  test("custom graph receives message and responds", async () => {
    const res = await sendMessage("product-agent", "Show me products")
    expect(res.data.result.status.state).toBe("completed")
  })

  test("response includes text content", async () => {
    const res = await sendMessage("product-agent", "Hello world")
    const text = res.data.result.status.message.parts[0].text
    expect(text).toBeDefined()
    expect(text.length).toBeGreaterThan(0)
  })

  test("returns valid A2A task structure", async () => {
    const res = await sendMessage("product-agent", "anything")
    const task = res.data.result
    expect(task.id).toBeDefined()
    expect(task.contextId).toBeDefined()
    expect(task.status.state).toBe("completed")
    expect(task.status.message.role).toBe("agent")
    expect(task.status.message.parts).toHaveLength(1)
    expect(task.status.message.parts[0].kind).toBe("text")
  })

  test("agent card is served", async () => {
    const res = await axios.get("/a2a/product-agent/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    expect(res.data.name).toBeDefined()
    expect(res.data.url).toContain("/a2a/product-agent")
  })

  test("tasks/get retrieves completed task", async () => {
    const sendRes = await sendMessage("product-agent", "test retrieval")
    const taskId = sendRes.data.result.id
    expect(taskId).toBeDefined()

    const getRes = await jsonrpc("product-agent", "tasks/get", { id: taskId })
    expect(getRes.data.result.status.state).toBe("completed")
    expect(getRes.data.result.id).toBe(taskId)
  })
})
