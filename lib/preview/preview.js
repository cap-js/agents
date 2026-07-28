import express from "express"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const _dir = dirname(fileURLToPath(import.meta.url))
const _chatTemplate = readFileSync(join(_dir, "chat.html"), "utf-8")

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
  router.get("/", (_req, res) => {
    const html = _chatTemplate.replace(/\{\{agentName\}\}/g, safeName)
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.send(html)
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
