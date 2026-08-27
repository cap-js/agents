import assert from "node:assert/strict"
import http from "node:http"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/deep-agent")
import createHelpers from "../utils/helpers.js"

describe("@cap-js/agents - Push Notification Delivery", () => {
  let jsonrpc, setupErrorDetection
  let webhookServer
  let webhookPort
  let received = []

  before(async () => {
    const helpers = createHelpers({ POST, axios })
    jsonrpc = helpers.jsonrpc
    setupErrorDetection = helpers.setupErrorDetection

    // Start mock webhook server
    webhookServer = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        received.push({
          headers: req.headers,
          body: JSON.parse(body),
        })
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

  beforeEach(() => {
    received = []
  })

  it("delivers webhook POST on task state change", { timeout: 30000 }, async () => {
    // Send streaming request with pushNotificationConfig inline
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
            parts: [{ kind: "text", text: "List all products" }],
          },
          configuration: {
            pushNotificationConfig: {
              url: `http://127.0.0.1:${webhookPort}/webhook`,
            },
          },
        },
      },
      { responseType: "text" },
    )

    await streamPromise.catch(() => {})

    // Wait for async webhook delivery
    await new Promise((r) => setTimeout(r, 2000))

    // Should have received at least one webhook POST
    assert.ok(received.length > 0, `expected webhook calls, got ${received.length}`)

    // Verify body is a task object
    const first = received[0]
    assert.ok(first.body.id, "webhook body should have task id")
    assert.ok(first.body.status, "webhook body should have status")
  })
})
