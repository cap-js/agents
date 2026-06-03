import assert from "node:assert/strict"
import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"
const { POST, axios } = cds.test(import.meta.dirname + "/../deep-agent-sample")

// deepagents has ESM-only transitive deps (p-retry) that fail to load in some
// Node versions but succeed on others.
let canLoad = true
try {
  await import("deepagents")
} catch {
  canLoad = false
}

describe("@cap-js/a2a - Custom Graph (deepagents)", { skip: !canLoad }, () => {
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
})
