import cds from "@sap/cds"
import express from "express"

import { generateAgentCard } from "./agent-card.js"
import { CdsTaskStore } from "./persistence/task-store.js"
import { short, audit } from "./utils.js"
import * as metrics from "./telemetry/metrics.js"

const LOG = cds.log("a2a")

// SSE wire-format helpers, mirroring @a2a-js/sdk's sse_utils so the adapter
// streams message/stream responses identically to the SDK's reference
// Express handler. Inlined (not imported) because the SDK does not export
// these from its public entry points.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // disable nginx buffering
}
function formatSSEEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}
function formatSSEErrorEvent(error) {
  return `event: error\ndata: ${JSON.stringify(error)}\n\n`
}

export default function A2AProtocolAdapter(srv, options = {}) {
  if (!(srv instanceof cds.ApplicationService)) {
    LOG.debug("Skipping non-ApplicationService", { service: srv.name })
    return null
  }

  const router = express.Router()

  const agentCard = generateAgentCard(srv, options)

  // Add "Agent Card" link to the CDS index page
  const linkProviders = (srv.$linkProviders ??= [])
  linkProviders.push((entity, endpoint) => {
    if (entity || endpoint?.kind !== "a2a") return undefined
    return {
      href: `${endpoint.path}/.well-known/agent-card.json`,
      name: "Agent Card",
      title: "A2A Agent Card",
    }
  })

  // Lazy-load SDK, connect to executor, and create request handler
  // Supports three executor patterns:
  //   1. srv.a2a = { executor } — custom executor set in service handler init()
  //   2. srv.a2a = { graph }   — custom LangGraph graph, plugin provides executor wrapper
  //   3. cds.connect.to("a2a-executor") — CDS service-based executor (default)
  let _requestHandler = null
  async function getRequestHandler() {
    if (_requestHandler) return _requestHandler

    const { DefaultRequestHandler } = await import("@a2a-js/sdk/server")

    let executor
    if (srv.a2a?.executor) {
      executor = srv.a2a.executor
    } else if (srv.a2a?.graph) {
      const { GraphExecutor } = await import("./executor/graph.js")
      executor = new GraphExecutor(srv.a2a.graph, srv, srv.a2a)
    } else {
      const executorService = await cds.connect.to("a2a-executor")
      executor = executorService.for(srv)
    }
    _requestHandler = new DefaultRequestHandler(agentCard, new CdsTaskStore(), executor)
    return _requestHandler
  }

  router.get("/.well-known/agent-card.json", (req, res) => {
    const url = `${req.protocol}://${req.get("host")}${req.baseUrl}`
    const card = { ...agentCard, url }
    if (card.supportedInterfaces) {
      card.supportedInterfaces = card.supportedInterfaces.map((iface) => ({
        ...iface,
        url,
      }))
    }
    res.json(card)
  })

  router.post("/", express.json({ limit: "5mb" }), async (req, res) => {
    const t0 = Date.now()
    const method = req.body?.method
    const taskId = req.body?.params?.message?.taskId || req.body?.params?.id || ""
    const contextId = req.body?.params?.message?.contextId || ""
    const requestAttrs = { ...metrics.attrs(srv), "a2a.method": method || "unknown" }

    metrics.requestsTotal.add(1, requestAttrs)

    // A2A correlation: set task/context IDs on active OTel span + rename
    const span = metrics.getActiveSpan()
    if (span) {
      span.updateName(`POST /a2a/${srv.name}/`)
      if (taskId) span.setAttribute("a2a.task.id", taskId)
      if (contextId) span.setAttribute("a2a.context.id", contextId)
    }

    if (method === "message/send" || method === "message/stream") {
      const text = req.body?.params?.message?.parts
        ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
        .map((p) => p.text)
        .join(" ")
      const truncated = text?.length > 80 ? text.slice(0, 80) + "..." : text
      LOG.info("request", { task: short(taskId), service: srv.name, method, text: truncated })
    } else {
      LOG.debug("request", { task: short(taskId), service: srv.name, method })
    }

    try {
      // Quota enforcement — return 429 before SDK processes the request
      // Skip for resume messages (have taskId — already past quota gate)
      if ((method === "message/send" || method === "message/stream") && !taskId) {
        const { default: quotaEnforcerAtStart } =
          await import("./executor/langgraph/nodes/quotaEnforcerAtStart.js")
        const quotaResult = await quotaEnforcerAtStart()
        if (quotaResult) {
          LOG.warn("quota exceeded", {
            task: short(taskId),
            service: srv.name,
            reason: quotaResult.message,
          })
          metrics.errorsTotal.add(1, { ...requestAttrs, "a2a.error.code": 429 })

          // Audit: security event for quota breach
          audit("QuotaExceeded", {
            data: {
              service: srv.name,
              user: cds.context?.user?.id,
              reason: quotaResult.message,
              forwardedIp: req.headers?.["x-forwarded-for"],
            },
            ip: req.ip,
          })

          if (!res.headersSent) {
            res
              .status(429)
              .set("Retry-After", String(quotaResult.retryAfter))
              .json({
                jsonrpc: "2.0",
                error: { code: -32029, message: quotaResult.message },
                id: req.body?.id || null,
              })
          }
          return
        }
        // Flag to toggle that the task must be inserted on save and not updated
        cds.context["a2a.new.task"] = true
      }

      const requestHandler = await getRequestHandler()
      const { JsonRpcTransportHandler } = await import("@a2a-js/sdk/server")
      const transport = new JsonRpcTransportHandler(requestHandler)
      const result = await transport.handle(req.body)

      // JsonRpcTransportHandler.handle() returns an AsyncGenerator for
      // method=message/stream and a plain JSON-RPC envelope for unary methods
      // (message/send, tasks/get, etc.). Passing the AsyncGenerator straight
      // to res.json() serialises it as `{}` — clients waiting for SSE then
      // see an empty body and time out.
      //
      // Mirror the SDK's reference Express handler (jsonRpcHandler in
      // @a2a-js/sdk/dist/server/express/index.cjs lines ~358-401): detect
      // the AsyncGenerator via Symbol.asyncIterator and stream events as
      // text/event-stream. Non-stream results continue through res.json.
      if (typeof result?.[Symbol.asyncIterator] === "function") {
        Object.entries(SSE_HEADERS).forEach(([k, v]) => res.setHeader(k, v))
        res.flushHeaders()
        // Release generator resources when the client disconnects early.
        req.on("close", () => result.return?.())
        try {
          for await (const event of result) {
            res.write(formatSSEEvent(event))
          }
        } catch (streamError) {
          const errMsg = String(streamError?.message ?? streamError) || "Streaming error."
          LOG.error("SSE stream failed", { task: short(taskId), error: errMsg })
          metrics.errorsTotal.add(1, { ...requestAttrs, "a2a.error.code": -32603 })
          // Headers are always flushed before this catch block is reachable,
          // so the only viable recovery is an SSE error frame.
          if (!res.writableEnded) {
            res.write(
              formatSSEErrorEvent({
                jsonrpc: "2.0",
                id: req.body?.id || null,
                error: { code: -32603, message: errMsg },
              }),
            )
          }
        } finally {
          if (!res.writableEnded) res.end()
        }
      } else {
        res.json(result)
      }
    } catch (err) {
      LOG.error("request failed", { task: short(taskId), method, error: err.message })
      LOG.debug("request failed stack", { task: short(taskId), stack: err.stack })

      metrics.errorsTotal.add(1, { ...requestAttrs, "a2a.error.code": -32603 })

      // In production, don't reveal internal error details to clients (CDS pattern)
      const PROD = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
      const message =
        PROD && err.$sanitize !== false
          ? cds.i18n.messages.at(500) || "Internal Server Error"
          : "Internal error: " + err.message

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: req.body?.id || null,
        })
      }
    } finally {
      // Duration only meaningful for non-streaming requests;
      // for message/stream the response is delivered asynchronously after this point
      if (method !== "message/stream") {
        metrics.requestDuration.record(Date.now() - t0, requestAttrs)
      }
    }
  })

  LOG.debug("Adapter initialized", { service: srv.name })

  router.router = router
  return router
}
