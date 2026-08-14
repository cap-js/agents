// Regression test for H9: client-disconnect abort path.
//
// lib/index.js registers `res.on("close", abortOnClose)`. Before the fix:
//
// Uses the SlowAgentService fixture whose graph awaits `config.signal`; the
// test kills the underlying TCP socket via node's http module and asserts
// the task reaches `canceled` state within a short window.

import path from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import cds from "@sap/cds"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const t = cds.test(path.join(__dirname, "../projects/bookshop"))

describe("@cap-js/agents - SSE client disconnect aborts running task", () => {
  it("aborts the graph and marks the task canceled when the SSE client disconnects", async () => {
    const u = new URL(`${t.url}/a2a/slow-agent/`)
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/stream",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [{ kind: "text", text: "slow please" }],
        },
      },
    })

    const { taskId, socket } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          agent: false, // dedicated connection so socket.destroy() releases it
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Accept: "text/event-stream",
            Connection: "close",
          },
        },
        (res) => {
          let buf = ""
          res.setEncoding("utf8")
          res.on("data", (chunk) => {
            buf += chunk
            const m = buf.match(/"id"\s*:\s*"([0-9a-f-]{36})"/)
            if (m) {
              res.pause()
              resolve({ taskId: m[1], socket: req.socket })
            }
          })
          res.on("error", reject)
        },
      )
      req.on("error", reject)
      req.write(body)
      req.end()
    })
    expect(taskId).toBeTruthy()

    // Force-close the TCP socket. The server sees `res.on("close")` fire
    // and the H9 disconnect handler abort()s the graph.
    socket.destroy()

    // Poll cap.agent.Tasks for the disconnect-triggered cancellation.
    await cds.connect.to("db")
    const Tasks = cds.model.definitions["cap.agent.Tasks"]
    const deadline = Date.now() + 5000
    let state
    // eslint-disable-next-line no-unmodified-loop-condition
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const row = await SELECT.one.from(Tasks).where({ taskId })
      state = row?.state
      if (state === "canceled") break
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(state, `expected task ${taskId} to reach 'canceled' after client disconnect`).toBe(
      "canceled",
    )
  }, 15_000)
})
