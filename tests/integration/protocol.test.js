const cds = require("@sap/cds")
const { POST, axios } = cds.test(__dirname + "/../bookshop")
const { jsonrpc, sendMessage, streamMessage, parseSSEFrames, setupErrorDetection } =
  require("./helpers")({ POST, axios })

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

describe("@cap-js/a2a - SSE Streaming (message/stream)", () => {
  setupErrorDetection()

  test("returns text/event-stream content-type", async () => {
    const res = await streamMessage("catalog", "Show me books")
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/)
  })

  test("response body is a ReadableStream, not {}", async () => {
    const res = await streamMessage("catalog", "Show me books")
    // naxios returns res.body (ReadableStream) for text/event-stream responses.
    // Before the fix, transport.handle() returned an AsyncGenerator that
    // res.json() serialised as {} — res.data would have been an empty object.
    expect(res.data).not.toEqual({})
    expect(typeof res.data?.getReader).toBe("function") // is a ReadableStream
  })

  test("streams valid JSON-RPC envelopes as SSE frames", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = await parseSSEFrames(res.data)

    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame.jsonrpc).toBe("2.0")
      expect(frame.id).toBe(1)
      expect(frame.result).toBeDefined()
    }
  })

  test("first frame has task submitted state", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = await parseSSEFrames(res.data)

    const taskFrame = frames.find((f) => f.result?.kind === "task")
    expect(taskFrame).toBeDefined()
    expect(taskFrame.result.status.state).toBe("submitted")
    expect(taskFrame.result.id).toBeDefined()
  })

  test("includes a working status frame before completion", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = await parseSSEFrames(res.data)

    const workingFrame = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.status?.state === "working",
    )
    expect(workingFrame).toBeDefined()
  })

  test("final frame has completed state", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = await parseSSEFrames(res.data)

    const last = frames[frames.length - 1]
    expect(last.result?.kind).toBe("status-update")
    expect(last.result?.status?.state).toBe("completed")
    expect(last.result?.status?.message?.parts[0]?.text).toBeDefined()
  })

  test("task submitted via stream is retrievable with tasks/get", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = await parseSSEFrames(res.data)

    const taskFrame = frames.find((f) => f.result?.kind === "task")
    const taskId = taskFrame?.result?.id
    expect(taskId).toBeDefined()

    const getRes = await jsonrpc("catalog", "tasks/get", { id: taskId })
    expect(getRes.data.result).toBeDefined()
    expect(getRes.data.result.id).toBe(taskId)
    expect(getRes.data.result.status.state).toBe("completed")
  })
})
