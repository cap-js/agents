import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/deep-agent")

describe("@cap-js/agents - Custom Graph (deepagents)", () => {
  let sendMessage, jsonrpc, setupErrorDetection
  before(async () => {
    const helpers = createHelpers({ POST, axios })
    sendMessage = helpers.sendMessage
    jsonrpc = helpers.jsonrpc
    setupErrorDetection = helpers.setupErrorDetection
  })

  it("custom graph receives message and responds", async () => {
    const res = await sendMessage("product-agent", "Show me products")
    expect(res.data.result.status.state).toBe("completed")
  })

  it("response includes text content", async () => {
    const res = await sendMessage("product-agent", "Hello world")
    const text = res.data.result.status.message.parts[0].text
    expect(text).not.toBe(undefined)
    expect(text.length > 0, `expected text.length > 0`).toBeTruthy()
  })

  it("returns valid A2A task structure", async () => {
    const res = await sendMessage("product-agent", "anything")
    const task = res.data.result
    expect(task.id).not.toBe(undefined)
    expect(task.contextId).not.toBe(undefined)
    expect(task.status.state).toBe("completed")
    expect(task.status.message.role).toBe("agent")
    expect(task.status.message.parts.length).toBe(1)
    expect(task.status.message.parts[0].kind).toBe("text")
  })

  it("agent card is served", async () => {
    const res = await axios.get("/a2a/product-agent/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    expect(res.data.name).not.toBe(undefined)
    expect(res.data.url.includes("/a2a/product-agent")).toBeTruthy()
  })

  it("tasks/get retrieves completed task", async () => {
    const sendRes = await sendMessage("product-agent", "test retrieval")
    const taskId = sendRes.data.result.id
    expect(taskId).not.toBe(undefined)

    const getRes = await jsonrpc("product-agent", "tasks/get", { id: taskId })
    expect(getRes.data.result.status.state).toBe("completed")
    expect(getRes.data.result.id).toBe(taskId)
  })

  // ── tasks/cancel ────────────────────────────────────────────────────────

  it("tasks/cancel cancels task in input-required state", async () => {
    // interruptOn: { orderProduct } should trigger HITL interrupt
    const res = await sendMessage("product-agent", "Order 5 Widget Pro")
    const state = res.data.result?.status?.state

    // LLM non-determinism: may not always call orderProduct tool
    expect(state).toBe("input-required")

    const taskId = res.data.result.id
    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: taskId })
    expect(cancelRes.data.result.status.state).toBe("canceled")
  })

  it("tasks/cancel returns error for completed task", async () => {
    const res = await sendMessage("product-agent", "Hello")
    const taskId = res.data.result.id
    expect(res.data.result.status.state).toBe("completed")

    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", { id: taskId })
    expect(cancelRes.data.error.code).toBe(-32002)
    expect(cancelRes.data.error.message.includes(taskId)).toBeTruthy()
  })

  it("tasks/cancel returns error for non-existent task", async () => {
    const cancelRes = await jsonrpc("product-agent", "tasks/cancel", {
      id: "does-not-exist-task-id",
    })
    expect(cancelRes.data.error.code).toBe(-32001)
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
    expect(
      cancelRes.data.result?.status?.state === "canceled" || cancelRes.data.error?.code === -32002,
      "expected canceled state or taskNotCancelable error",
    ).toBeTruthy()

    // Let stream finish to avoid dangling connections
    await streamPromise.catch(() => {})
  })
})
