import assert from "node:assert/strict"
import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/deep-agent")

// deepagents has ESM-only transitive deps (p-retry) that fail to load in some
// Node versions but succeed on others.
let canLoad = true
try {
  await import("deepagents")
} catch {
  canLoad = false
}

describe("@cap-js/agent - Custom Graph (deepagents)", { skip: !canLoad }, () => {
  let sendMessage, jsonrpc, setupErrorDetection
  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
    jsonrpc = helpers.jsonrpc
    setupErrorDetection = helpers.setupErrorDetection
  })

  it("custom graph receives message and responds", async () => {
    const res = await sendMessage("product-agent", "Show me products")
    assert.strictEqual(res.data.result.status.state, "completed")
  })

  it("response includes text content", async () => {
    const res = await sendMessage("product-agent", "Hello world")
    const text = res.data.result.status.message.parts[0].text
    assert.notStrictEqual(text, undefined)
    assert.ok(text.length > 0, `expected text.length > 0`)
  })

  it("returns valid A2A task structure", async () => {
    const res = await sendMessage("product-agent", "anything")
    const task = res.data.result
    assert.notStrictEqual(task.id, undefined)
    assert.notStrictEqual(task.contextId, undefined)
    assert.strictEqual(task.status.state, "completed")
    assert.strictEqual(task.status.message.role, "agent")
    assert.strictEqual(task.status.message.parts.length, 1)
    assert.strictEqual(task.status.message.parts[0].kind, "text")
  })

  it("agent card is served", async () => {
    const res = await axios.get("/a2a/product-agent/.well-known/agent-card.json")
    assert.strictEqual(res.status, 200)
    assert.notStrictEqual(res.data.name, undefined)
    assert.ok(res.data.url.includes("/a2a/product-agent"))
  })

  it("tasks/get retrieves completed task", async () => {
    const sendRes = await sendMessage("product-agent", "test retrieval")
    const taskId = sendRes.data.result.id
    assert.notStrictEqual(taskId, undefined)

    const getRes = await jsonrpc("product-agent", "tasks/get", { id: taskId })
    assert.strictEqual(getRes.data.result.status.state, "completed")
    assert.strictEqual(getRes.data.result.id, taskId)
  })

  // ── tasks/cancel ────────────────────────────────────────────────────────

  it("tasks/cancel cancels task in input-required state", async () => {
    // interruptOn: { orderProduct } should trigger HITL interrupt
    const res = await sendMessage("product-agent", "Order 5 Widget Pro")
    const state = res.data.result?.status?.state

    // LLM non-determinism: may not always call orderProduct tool
    assert.strictEqual(state, "input-required")

    const taskId = res.data.result.id
    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: taskId })
    assert.strictEqual(cancelRes.data.result.status.state, "canceled")
  })

  it("tasks/cancel returns error for completed task", async () => {
    const res = await sendMessage("product-agent", "Hello")
    const taskId = res.data.result.id
    assert.strictEqual(res.data.result.status.state, "completed")

    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: taskId })
    assert.strictEqual(cancelRes.data.error.code, -32002)
    assert.ok(cancelRes.data.error.message.includes(taskId))
  })

  it("tasks/cancel returns error for non-existent task", async () => {
    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", {
      id: "does-not-exist-task-id",
    })
    assert.strictEqual(cancelRes.data.error.code, -32001)
  })

  it("tasks/cancel can cancel actively running task", async () => {
    // Fire stream request without awaiting — LLM calls take seconds
    const streamPromise = POST(
      "/a2a/product-agent/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [
              {
                kind: "text",
                text: "Give me a detailed analysis of all products including bulk pricing calculations for 100 units of each product",
              },
            ],
          },
        },
      },
      { responseType: "text" },
    )

    // Give server time to create task and start execution
    await new Promise((r) => setTimeout(r, 1000))

    // Query task store for most recent non-completed task
    const [task] = await SELECT.from("cap.agent.Tasks").orderBy("createdAt desc").limit(1)

    if (!task?.taskId || task.state === "completed" || task.state === "failed") {
      // Task already finished — can't test active cancel, skip gracefully
      await streamPromise.catch(() => {})
      return
    }

    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: task.taskId })
    // Accept: canceled (won race) or taskNotCancelable (lost race — completed before cancel)
    assert.ok(
      cancelRes.data.result?.status?.state === "canceled" || cancelRes.data.error?.code === -32002,
      "expected canceled state or taskNotCancelable error",
    )

    // Let stream finish to avoid dangling connections
    await streamPromise.catch(() => {})
  })
})
