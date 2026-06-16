import assert from "node:assert/strict"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../bookshop")
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

describe("@cap-js/agent - JSON-RPC Protocol", () => {
  setupErrorDetection()

  it("returns error for invalid JSON-RPC (missing method)", async () => {
    const res = await POST("/a2a/catalog/", { invalid: true })
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.error || res.data.jsonrpc, undefined)
  })

  it("returns method-not-found for unknown method", async () => {
    const res = await jsonrpc("catalog", "nonexistent/method")
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.error, undefined)
  })

  it("message/send - returns a completed task", async () => {
    const res = await sendMessage("catalog", "What books do you have?")
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.result, undefined)
    assert.strictEqual(res.data.result.status.state, "completed")
    assert.ok(res.data.result.status.message.parts[0].text.includes("Wuthering Heights"))
    const text = res.data.result.status.message.parts[0].text
    assert.ok(text)
    assert.doesNotMatch(text, /technical issue|issue|technical|not installed|configuration issue/i)
  })

  it("tasks/get - retrieves a completed task by ID", async () => {
    const sendRes = await sendMessage("catalog", "What books do you have?")
    assert.strictEqual(sendRes.data.result.status.state, "completed")
    const taskId = sendRes.data.result.id

    const getRes = await jsonrpc("catalog", "tasks/get", { id: taskId })
    assert.notStrictEqual(getRes.data.result, undefined)
    assert.strictEqual(getRes.data.result.id, taskId)
    assert.strictEqual(getRes.data.result.status.state, "completed")
  })

  it("tasks/get - returns error for non-existent task ID", async () => {
    const res = await jsonrpc("catalog", "tasks/get", { id: "non-existent-id" })
    assert.notStrictEqual(res.data.error, undefined)
  })
})

describeMock("@cap-js/agent - SSE Streaming (message/stream)", () => {
  setupErrorDetection()

  it("returns text/event-stream content-type", async () => {
    const res = await streamMessage("catalog", "Show me books")
    assert.match(res.headers["content-type"], /text\/event-stream/)
  })

  it("response body is SSE text, not {}", async () => {
    const res = await streamMessage("catalog", "Show me books")
    // Before the fix, transport.handle() returned an AsyncGenerator that
    // res.json() serialised as {} — res.data would have been an empty object.
    // Now res.data is the raw SSE body as a string containing data: frames.
    assert.strictEqual(typeof res.data, "string")
    assert.ok(res.data.includes("data: "))
  })

  it("streams valid JSON-RPC envelopes as SSE frames", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    assert.ok(frames.length > 0)
    for (const frame of frames) {
      assert.strictEqual(frame.jsonrpc, "2.0")
      assert.strictEqual(frame.id, 1)
      assert.notStrictEqual(frame.result, undefined)
    }
  })

  it("first frame has task submitted state", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const taskFrame = frames.find((f) => f.result?.kind === "task")
    assert.notStrictEqual(taskFrame, undefined)
    assert.strictEqual(taskFrame.result.status.state, "submitted")
    assert.notStrictEqual(taskFrame.result.id, undefined)
  })

  it("includes a working status frame before completion", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const workingFrame = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.status?.state === "working",
    )
    assert.notStrictEqual(workingFrame, undefined)
  })

  it("final frame has completed state", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const last = frames[frames.length - 1]
    assert.strictEqual(last.result?.kind, "status-update")
    assert.strictEqual(last.result?.status?.state, "completed")
    assert.notStrictEqual(last.result?.status?.message?.parts[0]?.text, undefined)
  })

  it("task submitted via stream is retrievable with tasks/get", async () => {
    const res = await streamMessage("catalog", "Show me books")
    const frames = parseSSEFrames(res.data)

    const taskFrame = frames.find((f) => f.result?.kind === "task")
    const taskId = taskFrame?.result?.id
    assert.notStrictEqual(taskId, undefined)

    const getRes = await jsonrpc("catalog", "tasks/get", { id: taskId })
    assert.notStrictEqual(getRes.data.result, undefined)
    assert.strictEqual(getRes.data.result.id, taskId)
    assert.strictEqual(getRes.data.result.status.state, "completed")
  })
})
