import assert from "node:assert/strict"
import http from "node:http"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { jsonrpc, sendMessage, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agents - Push Notifications", () => {
  setupErrorDetection()

  let webhookServer
  let webhookPort

  before(async () => {
    webhookServer = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        res.writeHead(200)
        res.end()
      })
    })
    await new Promise((resolve) => {
      webhookServer.listen(0, "127.0.0.1", resolve)
    })
    webhookPort = webhookServer.address().port
  })

  after(() => {
    webhookServer?.close()
  })

  it("agent card advertises pushNotifications capability", async () => {
    const res = await axios.get("/a2a/catalog/.well-known/agent-card.json")
    assert.strictEqual(res.data.capabilities.pushNotifications, true)
  })

  it("tasks/pushNotificationConfig/set - registers a webhook for a task", async () => {
    const sendRes = await sendMessage("catalog", "What books do you have?")
    const taskId = sendRes.data.result.id

    const res = await jsonrpc("catalog", "tasks/pushNotificationConfig/set", {
      taskId,
      pushNotificationConfig: {
        url: `http://127.0.0.1:${webhookPort}/webhook`,
        token: "test-secret-token",
      },
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.data.error, undefined, JSON.stringify(res.data.error))
  })

  it("tasks/pushNotificationConfig/get - retrieves saved config", async () => {
    const sendRes = await sendMessage("catalog", "What books do you have?")
    const taskId = sendRes.data.result.id

    await jsonrpc("catalog", "tasks/pushNotificationConfig/set", {
      taskId,
      pushNotificationConfig: {
        url: `http://127.0.0.1:${webhookPort}/webhook`,
        token: "my-token",
      },
    })

    const res = await jsonrpc("catalog", "tasks/pushNotificationConfig/get", { id: taskId })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.data.error, undefined, JSON.stringify(res.data.error))
    const result = res.data.result
    assert.ok(result?.pushNotificationConfig?.url, "expected pushNotificationConfig with url")
  })

  it("tasks/pushNotificationConfig/delete - removes config", async () => {
    const sendRes = await sendMessage("catalog", "What books do you have?")
    const taskId = sendRes.data.result.id

    await jsonrpc("catalog", "tasks/pushNotificationConfig/set", {
      taskId,
      pushNotificationConfig: {
        url: `http://127.0.0.1:${webhookPort}/webhook`,
      },
    })

    const delRes = await jsonrpc("catalog", "tasks/pushNotificationConfig/delete", { id: taskId })
    assert.strictEqual(delRes.status, 200)
    assert.strictEqual(delRes.data.error, undefined, JSON.stringify(delRes.data.error))

    // Get after delete should error (no configs found)
    const getRes = await jsonrpc("catalog", "tasks/pushNotificationConfig/get", { id: taskId })
    assert.notStrictEqual(getRes.data.error, undefined, "expected error after delete")
  })

  it("tasks/pushNotificationConfig/set - returns error for non-existent task", async () => {
    const res = await jsonrpc("catalog", "tasks/pushNotificationConfig/set", {
      taskId: "non-existent-task-id",
      pushNotificationConfig: {
        url: `http://127.0.0.1:${webhookPort}/webhook`,
      },
    })

    assert.notStrictEqual(res.data.error, undefined, "expected error for non-existent task")
  })
})
