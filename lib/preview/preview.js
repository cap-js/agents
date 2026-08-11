import express from "express"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import { createRequire } from "node:module"

const _dir = dirname(fileURLToPath(import.meta.url))
const _chatTemplate = readFileSync(join(_dir, "chat.html"), "utf-8")
const _require = createRequire(import.meta.url)
const _markedPath = join(dirname(_require.resolve("marked/package.json")), "lib", "marked.umd.js")
const _markedJs = readFileSync(_markedPath, "utf-8")

const sessions = new Map() // sessionId → Set<res>

export default function preview(agentName) {
  const router = express.Router()

  const safeName = agentName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

  // Serve chat preview UI
  router.get("/", (req, res) => {
    if (!req.originalUrl.split("?")[0].endsWith("/")) {
      const [pathPart, query = ""] = req.originalUrl.split("?")
      return res.redirect(301, pathPart + "/" + (query ? "?" + query : ""))
    }
    // Echo the browser's Authorization header into the page
    const authHeader = (req.headers.authorization || "").replace(/"/g, "&quot;")
    const html = _chatTemplate
      .replace(/\{\{agentName\}\}/g, safeName)
      .replace(/\{\{authHeader\}\}/g, authHeader)
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.send(html)
  })

  // Serve bundled marked.js (avoids non-SAP CDN dependency)
  router.get("/marked.min.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8")
    res.setHeader("Cache-Control", "public, max-age=86400")
    res.send(_markedJs)
  })

  // SSE bridge — browser subscribes here to receive relayed push notifications
  router.get("/push/:sessionId", (req, res) => {
    const { sessionId } = req.params
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders()

    if (!sessions.has(sessionId)) sessions.set(sessionId, new Set())
    sessions.get(sessionId).add(res)

    req.on("close", () => {
      sessions.get(sessionId)?.delete(res)
      if (sessions.get(sessionId)?.size === 0) sessions.delete(sessionId)
    })
  })

  // Webhook receiver — SDK posts task updates here
  router.post("/push/:sessionId", express.json(), (req, res) => {
    const { sessionId } = req.params
    const token = req.headers["x-a2a-notification-token"]
    if (token && token !== sessionId) {
      res.status(403).end()
      return
    }
    const subscribers = sessions.get(sessionId)
    if (subscribers) {
      const data = `data: ${JSON.stringify(req.body)}\n\n`
      for (const sub of subscribers) sub.write(data)
    }
    res.status(200).end()
  })

  return router
}
