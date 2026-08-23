import cds from "@sap/cds"
import { createRequire } from "node:module"

import AgentService from "./agentService.js"
import preview from "./preview/preview.js"
import { text } from "node:stream/consumers"
import { pipeline } from "node:stream/promises"

// TODO: finally expose the HTTP adapter as a pluggable entry point
const _require = createRequire(import.meta.url)
const HttpAdapter = _require("@sap/cds/lib/srv/protocols/http")

const LOG = cds.log("a2a|agents")

export class A2AAdapter extends HttpAdapter {
  get router() {
    const router = super.router // creates express.Router and mounts this.authorize
    const srv = this.service
    const options = this.options

    const agentName = srv.definition?.["@title"] ?? srv.name

    router.post("/", async (req, res) => {
      // TODO: remove JSON.parse turn into message stream
      const body = await text(req)
      const { method, params, id = null } = JSON.parse(body) ?? {}

      const message = params?.message
      const contextId = message?.contextId ?? cds.utils.uuid()

      LOG.info("request", { contextId, service: srv.name, method })

      try {
        const agentSrv = srv instanceof AgentService ? srv : await cds.connect.to(options?.agents ?? 'agents')
        const session = await agentSrv.send('start', { ID: contextId, service: srv })

        let ID = message.messageId ?? cds.utils.uuid()
        req.rpc = { id, task: ID }

        // TODO: convert to parts stream
        for (const part of message?.parts || []) {
          if (part.kind !== 'text') continue // TODO: file / data part types
          session.write({ ID, role: message.role, type: part.kind, content: part.text })
          ID = cds.utils.uuid()
        }

        // TODO: add tasks/cancel handling to flag the session is canceled
        if (method === "message/stream") return this.stream(req, res, session)
        else if (method === "message/send") return this.send(req, res, session)

        return res.json({
          jsonrpc: "2.0", id,
          error: { code: -32601, message: "Method not found." }
        })
      } catch (err) {
        LOG.error("request failed", { contextId, method, error: err.stack })
        const PROD = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
        const message = PROD && err.$sanitize !== false
          ? cds.i18n.messages.at(500) || "Internal Server Error"
          : "Internal error: " + err.message
        if (!res.headersSent)
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message }, id })
      }
    })

    const linkProviders = (srv.$linkProviders ??= [])
    linkProviders.push((entity, endpoint) => {
      if (entity || endpoint?.kind !== "agent") return undefined
      return { href: `${endpoint.path}/.well-known/agent-card.json`, name: "Agent Card", title: "A2A Agent Card" }
    })

    if (cds.env?.server?.index) {
      linkProviders.push((entity, endpoint) => {
        if (entity || endpoint?.kind !== "agent") return undefined
        return { href: `${endpoint.path}/preview`, name: "Preview", title: "Preview in chat UI" }
      })

      router.use("/preview", preview(agentName))
    }

    router.get("/.well-known/agent-card.json", (req, res) => {
      const url = `${req.protocol}://${req.get("host")}${req.baseUrl}`
      const def = srv.definition
      res.json({
        kind: "agent-card",
        name: def?.["@title"] ?? srv.name,
        description: def?.["@description"] ?? "",
        url,
        version: "0.1",
        capabilities: { streaming: true },
        defaultInputModes: [
          "text/plain",
          // "application/json",       // structured data parts
          // "image/png", "image/jpeg", "image/gif", "image/webp",
          // "audio/mpeg", "audio/wav", "audio/ogg",
          // "video/mp4", "video/webm",
          // "application/octet-stream", // generic file upload
        ],
        defaultOutputModes: [
          "text/plain",
          // "application/json",       // structured data parts
          // "image/png", "image/jpeg",
          // "audio/mpeg",
          // "video/mp4",
          // "application/octet-stream", // generic file download
        ],
      })
    })

    router.all("/", (_req, res) => res
      .set("Allow", "POST")
      .status(405)
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
    )

    LOG.debug("Adapter initialized", { service: srv.name })
    return router
  }

  async stream(req, res, session) {
    // initialize response stream
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const contextId = session.session.ID
    const taskId = req.rpc.task
    const artifactId = cds.utils.uuid()
    let append = false
    let text = null

    await pipeline(session,
      async function* (session) {
        yield {
          kind: "task",
          id: taskId, contextId,
          status: { state: "working", timestamp: new Date().toISOString() },
        }

        for await (const message of session) {
          if (message.role === 'flush') break
          if (message.type === "reasoning" || message.type === "tool_call" || message.type === "tool_result") continue

          if (text) {
            yield {
              kind: "artifact-update",
              taskId, contextId, append, lastChunk: false,
              artifact: { artifactId, parts: [{ kind: "text", text }] },
            }
            append = true
          }
          text = message.content
        }
        if (text) {
          yield {
            kind: "artifact-update",
            taskId, contextId, append, lastChunk: true,
            artifact: { artifactId, parts: [{ kind: "text", text }] },
          }
        }

        yield {
          kind: "status-update",
          taskId, contextId, final: true, status: {
            state: "completed", timestamp: new Date().toISOString()
          },
        }
      },
      sse.bind(null, { id: session.session.ID }),
      res,
    )
  }

  async send(req, res, session) {
    let replyText = ""
    for await (const chunk of session) {
      if (chunk.type === "reasoning" || chunk.type === "tool_call" || chunk.type === "tool_result") continue
      replyText = chunk.content ?? ""
      break
    }
    const contextId = session.session.ID
    const taskId = req.rpc.task
    res.json({
      jsonrpc: "2.0", id: req.rpc.id,
      result: {
        kind: "task", id: taskId, contextId,
        status: {
          state: "completed",
          timestamp: new Date().toISOString(),
          message: { kind: "message", messageId: cds.utils.uuid(), role: "agent", parts: [{ kind: "text", text: replyText }], contextId, taskId },
        },
      },
    })
  }

  error(err, req, res, next) {
    const status = err || err?.status == 401 || err?.code
    if (!(status == 401 || status == 403) || req.method !== "POST" || res.headersSent)
      return super.error(err, req, res, next)

    const anonymous = status == 401
    res.writeHead(status, { "Content-Type": "application/json" })
    return res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: {
        code: anonymous ? -32001 : -32003,
        message: cds.i18n.messages.at(anonymous ? "UNAUTHORIZED" : "FORBIDDEN"),
      },
    }))
  }
}

async function* sse({ id }, messages) {
  const prefix = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":`
  try {
    for await (const message of messages) {
      yield `data: ${prefix}${JSON.stringify(message)}}\n\n`
    }
  } catch (err) {
    LOG.error("stream failed", { error: err })
    yield `event: error\ndata: ${JSON.stringify(err)}\n\n`
  }
}
