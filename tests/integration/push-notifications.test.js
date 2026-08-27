import assert from "node:assert/strict"
import http from "node:http"
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
import createHelpers from "../utils/helpers.js"
const { jsonrpc, sendMessage, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agents - Push Notifications", () => {
  setupErrorDetection()

  let webhookServer
  let webhookPort
  const handlers = new Map()
  const received = []

  before(async () => {
    webhookServer = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        received.push({ path: req.url, method: req.method, body, headers: req.headers })
        const handler = handlers.get(req.url)
        if (handler) return handler(req, res)
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
    handlers.clear()
    received.length = 0
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

  // ── Redirect hardening ───────────────────────────────────────────────────

  describe("redirect hardening", () => {
    const url = (path) => `http://127.0.0.1:${webhookPort}${path}`
    const minimalTask = () => ({ id: "task-" + cds.utils.uuid() })

    async function emit(pathOrUrl) {
      const srv = await cds.connect.to("agent-push-notifications")
      return srv.emit("pushNotification", {
        task: minimalTask(),
        url: pathOrUrl.startsWith("http") ? pathOrUrl : url(pathOrUrl),
      })
    }

    // ── Direct delivery ───────────────────────────────────────────────

    it("delivers directly when target returns 200", async () => {
      handlers.set("/deliver", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await emit("/deliver")

      assert.equal(received.length, 1)
      assert.equal(received[0].path, "/deliver")
      assert.equal(received[0].method, "POST")
    })

    // ── 307 / 308 within the allowlist ────────────────────────────────

    it("follows a 307 redirect within the allowlist and preserves POST body", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(307, { Location: url("/final") })
        res.end()
      })
      handlers.set("/final", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await emit("/start")

      assert.equal(received.length, 2)
      assert.equal(received[0].path, "/start")
      assert.equal(received[1].path, "/final")
      assert.equal(received[1].method, "POST", "307 must preserve POST method")
      // Body carries the task JSON payload — verify it survives the redirect.
      assert.match(received[1].body, /"id":"task-/, "body must be preserved across 307")
    })

    it("follows a 308 redirect within the allowlist and preserves POST body", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(308, { Location: url("/final") })
        res.end()
      })
      handlers.set("/final", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await emit("/start")

      assert.equal(received.length, 2)
      assert.equal(received[1].method, "POST")
      assert.match(received[1].body, /"id":"task-/)
    })

    it("resolves relative Location values against the previous URL", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(307, { Location: "/final-relative" })
        res.end()
      })
      handlers.set("/final-relative", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await emit("/start")

      assert.equal(received.length, 2)
      assert.equal(received[1].path, "/final-relative")
    })

    // ── Redirect to off-allowlist host ────────────────────────────────

    it("refuses to follow a 307 redirect to a host outside the allowlist", async () => {
      handlers.set("/start", (_req, res) => {
        // `.invalid` TLD is reserved and never resolves — proves the refusal
        // fires before any DNS lookup / connection attempt.
        res.writeHead(307, { Location: "http://not-allowed.example.invalid/steal" })
        res.end()
      })

      await assert.rejects(emit("/start"), /not on allowlist/)
      assert.equal(received.length, 1, "only the initial hop should have been contacted")
      assert.equal(received[0].path, "/start")
    })

    // ── Method-changing redirects ─────────────────────────────────────

    it("refuses a 302 redirect (would silently downgrade POST → GET)", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(302, { Location: url("/final") })
        res.end()
      })
      handlers.set("/final", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await assert.rejects(emit("/start"), /would change method|drop body/)
      assert.equal(received.length, 1)
      assert.equal(received[0].path, "/start")
    })

    it("refuses a 301 redirect", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(301, { Location: url("/final") })
        res.end()
      })

      await assert.rejects(emit("/start"), /would change method|drop body/)
    })

    it("refuses a 303 redirect", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(303, { Location: url("/final") })
        res.end()
      })

      await assert.rejects(emit("/start"), /would change method|drop body/)
    })

    // ── Redirect hop cap ──────────────────────────────────────────────

    it("refuses after 3 redirects (max hop cap)", async () => {
      handlers.set("/h0", (_req, res) => {
        res.writeHead(307, { Location: url("/h1") })
        res.end()
      })
      handlers.set("/h1", (_req, res) => {
        res.writeHead(307, { Location: url("/h2") })
        res.end()
      })
      handlers.set("/h2", (_req, res) => {
        res.writeHead(307, { Location: url("/h3") })
        res.end()
      })
      handlers.set("/h3", (_req, res) => {
        // 4th hop: not reachable within the 3-hop cap.
        res.writeHead(307, { Location: url("/h4") })
        res.end()
      })
      handlers.set("/h4", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await assert.rejects(emit("/h0"), /exceeded 3 redirects/)
      const paths = received.map((r) => r.path)
      assert.deepEqual(paths, ["/h0", "/h1", "/h2", "/h3"], "/h4 must not be reached")
    })

    it("succeeds when redirect chain length equals the hop cap exactly", async () => {
      handlers.set("/h0", (_req, res) => {
        res.writeHead(307, { Location: url("/h1") })
        res.end()
      })
      handlers.set("/h1", (_req, res) => {
        res.writeHead(307, { Location: url("/h2") })
        res.end()
      })
      handlers.set("/h2", (_req, res) => {
        res.writeHead(307, { Location: url("/h3") })
        res.end()
      })
      handlers.set("/h3", (_req, res) => {
        res.writeHead(200)
        res.end()
      })

      await emit("/h0")
      const paths = received.map((r) => r.path)
      assert.deepEqual(paths, ["/h0", "/h1", "/h2", "/h3"])
    })

    // ── 3xx without Location ──────────────────────────────────────────

    it("treats 3xx without Location as a final response (no follow attempted)", async () => {
      handlers.set("/start", (_req, res) => {
        res.writeHead(307)
        res.end()
      })

      // The handler returns 307 with no Location. Our fix returns it as-is;
      // pushNotification() then treats it as a 4xx-shaped permanent failure
      // (< 500 and non-ok), logs an error, resolves without throwing.
      await emit("/start")
      assert.equal(received.length, 1)
      assert.equal(received[0].path, "/start")
    })
  })
})
