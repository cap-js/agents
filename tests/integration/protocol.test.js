const cds = require("@sap/cds")
const { POST, axios } = cds.test(__dirname + "/../bookshop")
const { jsonrpc, sendMessage, setupErrorDetection } = require("./helpers")({ POST, axios })

describe("@cap-js/a2a - JSON-RPC Protocol", () => {
  setupErrorDetection()

  test("returns error for invalid JSON-RPC (missing method)", async () => {
    const res = await POST("/a2a/catalog/", { invalid: true })
    expect(res.status).toBe(200)
    expect(res.data.error || res.data.jsonrpc).toBeDefined()
  })

  test("returns method-not-found for unknown method", async () => {
    const res = await jsonrpc("catalog", "nonexistent/method")
    expect(res.status).toBe(200)
    expect(res.data.error).toBeDefined()
  })

  test("message/send - returns a completed task", async () => {
    const res = await sendMessage("catalog", "What books do you have?")
    expect(res.status).toBe(200)
    expect(res.data.result).toBeDefined()
    expect(res.data.result.status.state).toBe("completed")
    expect(res.data.result.status.message.parts[0].text).toContain("Wuthering Heights")
    const text = res.data.result.status.message.parts[0].text
    expect(text).toBeTruthy()
    expect(text).not.toMatch(/technical issue|issue|technical|not installed|configuration issue/i)
  })

  test("tasks/get - retrieves a completed task by ID", async () => {
    const sendRes = await sendMessage("catalog", "What books do you have?")
    expect(sendRes.data.result.status.state).toBe("completed")
    const taskId = sendRes.data.result.id

    const getRes = await jsonrpc("catalog", "tasks/get", { id: taskId })
    expect(getRes.data.result).toBeDefined()
    expect(getRes.data.result.id).toBe(taskId)
    expect(getRes.data.result.status.state).toBe("completed")
  })

  test("tasks/get - returns error for non-existent task ID", async () => {
    const res = await jsonrpc("catalog", "tasks/get", { id: "non-existent-id" })
    expect(res.data.error).toBeDefined()
  })
})
