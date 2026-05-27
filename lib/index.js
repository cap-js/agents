const cds = require("@sap/cds")
const express = require("express")

const { generateAgentCard } = require("./agent-card")
const { CdsTaskStore } = require("./persistence/task-store")
const { short } = require("./utils")
const metrics = require("./telemetry/metrics")

const LOG = cds.log("a2a")

module.exports = function A2AProtocolAdapter(srv, options = {}) {
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

    const { DefaultRequestHandler } = require("@a2a-js/sdk/server")

    let executor
    if (srv.a2a?.executor) {
      executor = srv.a2a.executor
    } else if (srv.a2a?.graph) {
      const { GraphExecutor } = require("./executor/graph")
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
        const quotaEnforcerAtStart = require("./executor/langgraph/nodes/quotaEnforcerAtStart")
        const quotaResult = await quotaEnforcerAtStart()
        if (quotaResult) {
          LOG.warn("quota exceeded", {
            task: short(taskId),
            service: srv.name,
            reason: quotaResult.message,
          })
          metrics.errorsTotal.add(1, { ...requestAttrs, "a2a.error.code": 429 })
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
      }

      const requestHandler = await getRequestHandler()
      const { JsonRpcTransportHandler } = require("@a2a-js/sdk/server")
      const transport = new JsonRpcTransportHandler(requestHandler)
      const result = await transport.handle(req.body)
      res.json(result)
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
