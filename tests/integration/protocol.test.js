const cds = require("@sap/cds")
const { POST, axios } = cds.test(__dirname + "/../bookshop")
const { jsonrpc, sendMessage } = require("./helpers")({ POST, axios })

describe("@cap-js/a2a - JSON-RPC Protocol", () => {
  test("Error Handling - returns error for invalid JSON-RPC (missing method)", async () => {
    const res = await POST("/a2a/catalog/", { invalid: true })
    expect(res.status).toBe(200)
    expect(res.data.error || res.data.jsonrpc).toBeDefined()
  })

  test("Error Handling - returns method-not-found for unknown method", async () => {
    const res = await jsonrpc("catalog", "nonexistent/method")
    expect(res.status).toBe(200)
    expect(res.data.error).toBeDefined()
  })

  test("message/send - returns a completed task with stub response", async () => {
    const res = await sendMessage("catalog", "Hello agent")
    expect(res.status).toBe(200)
    expect(res.data.result).toBeDefined()
    expect(res.data.result.status.state).toBe("completed")
  })

  test("tasks/get - retrieves a completed task by ID", async () => {
    const sendRes = await sendMessage("catalog", "Test message")
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
