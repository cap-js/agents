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

  return router
}
