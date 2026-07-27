import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { jsonrpc, sendMessage, streamMessage, parseSSEFrames, setupErrorDetection } = createHelpers({
  POST,
  axios,
})

const isHybrid = cds.env.profiles?.includes("hybrid")
const isMock = !isHybrid
// SSE streaming tests use the mock executor only: the streaming plumbing is
// executor-independent, and running real LLM calls per test would leave
// unread SSE streams open, exhausting the concurrent-task quota in hybrid.
const describeMock = isMock ? describe : describe.skip

describe("@cap-js/agents - JSON-RPC Protocol", () => {
  setupErrorDetection()

  it("returns error for invalid JSON-RPC (missing method)", async () => {
    const res = await POST("/a2a/catalog/", { invalid: true })
    expect(res.status).toBe(200)
    expect(res.data.error || res.data.jsonrpc).not.toBe(undefined)
  })

  it("returns method-not-found for unknown method", async () => {
    const res = await jsonrpc("catalog", "nonexistent/method")
    expect(res.status).toBe(200)
    expect(res.data.error).not.toBe(undefined)
  })

  it("message/send - returns a completed task", async () => {
    const res = await sendMessage("catalog", "What books do you have?")
    expect(res.status).toBe(200)
    expect(res.data.result).not.toBe(undefined)
    expect(res.data.result.status.state).toBe("completed")
    expect(res.data.result.status.message.parts[0].text.includes("Wuthering Heights")).toBeTruthy()
    const text = res.data.result.status.message.parts[0].text
    expect(text).toBeTruthy()
    expect(text).not.toMatch(/technical issue|issue|technical|not installed|configuration issue/i)
  })

  it("tasks/get - retrieves a completed task by ID", async () => {
    const sendRes = await sendMessage("catalog", "What books do you have?")
    expect(sendRes.data.result.status.state).toBe("completed")
    const taskId = sendRes.data.result.id

    const getRes = await jsonrpc("catalog", "tasks/get", { id: taskId })
    expect(getRes.data.result).not.toBe(undefined)
    expect(getRes.data.result.id).toBe(taskId)
    expect(getRes.data.result.status.state).toBe("completed")
  })

  it("tasks/get - returns error for non-existent task ID", async () => {
    const res = await jsonrpc("catalog", "tasks/get", { id: "non-existent-id" })
    expect(res.data.error).not.toBe(undefined)
  })
})

describeMock("@cap-js/agents - SSE Streaming (message/stream)", () => {
  setupErrorDetection()

  it("returns text/event-stream content-type", async () => {
    const res = await streamMessage("catalog", "Show me books")
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/)
  })

  it("response body is SSE text, not {}", async () => {
    const res = await streamMessage("catalog", "Show me books")
    // Before the fix, transport.handle() returned an AsyncGenerator that
    // res.json() serialised as {} — res.data would have been an empty object.
    // Now res.data is the raw SSE body as a string containing data: frames.
    expect(typeof res.data).toBe("string")
    expect(res.data.includes("data: ")).toBeTruthy()
  })

  it("streams valid JSON-RPC envelopes as SSE frames", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    expect(frames.length > 0).toBeTruthy()
    for (const frame of frames) {
      expect(frame.jsonrpc).toBe("2.0")
      expect(frame.id).toBe(1)
      expect(frame.result).not.toBe(undefined)
    }
  })

  it("first frame has task submitted state", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const taskFrame = frames.find((f) => f.result?.kind === "task")
    expect(taskFrame).not.toBe(undefined)
    expect(taskFrame.result.status.state).toBe("submitted")
    expect(taskFrame.result.id).not.toBe(undefined)
  })

  it("includes a working status frame before completion", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const workingFrame = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.status?.state === "working",
    )
    expect(workingFrame).not.toBe(undefined)
  })

  it("final frame has completed state", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const last = frames[frames.length - 1]
    expect(last.result?.kind).toBe("status-update")
    expect(last.result?.status?.state).toBe("completed")
    expect(last.result?.status?.message?.parts[0]?.text).not.toBe(undefined)
  })

  it("task submitted via stream is retrievable with tasks/get", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const taskFrame = frames.find((f) => f.result?.kind === "task")
    const taskId = taskFrame?.result?.id
    expect(taskId).not.toBe(undefined)

    const getRes = await jsonrpc("catalog", "tasks/get", { id: taskId })
    expect(getRes.data.result).not.toBe(undefined)
    expect(getRes.data.result.id).toBe(taskId)
    expect(getRes.data.result.status.state).toBe("completed")
  })
})
