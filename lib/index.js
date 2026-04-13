const cds = require("@sap/cds")
const express = require("express")

const { generateAgentCard } = require("./agent-card")
const { CdsTaskStore } = require("./persistence/task-store")

const LOG = cds.log("a2a")

module.exports = function A2AProtocolAdapter(srv, options = {}) {
  if (!(srv instanceof cds.ApplicationService)) {
    LOG.debug("Skipping non-ApplicationService", { service: srv.name })
    return null
  }

  const router = express.Router()

  const agentCard = generateAgentCard(srv, options)

  const executor = mockExecutor

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

  // Lazy-load SDK and create request handler
  let _requestHandler = null
  async function getRequestHandler() {
    if (_requestHandler) return _requestHandler

    const { DefaultRequestHandler } = require("@a2a-js/sdk/server")

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
    const method = req.body?.method

    // Only for logging
    if (method === "message/send" || method === "message/stream") {
      const text = req.body?.params?.message?.parts
        ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
        .map((p) => p.text)
        .join(" ")
      const truncated = text?.length > 80 ? text.slice(0, 80) + "..." : text
      LOG.info(method, `"${truncated}"`)
    } else {
      LOG.info(method)
    }

    try {
      const requestHandler = await getRequestHandler()
      const { JsonRpcTransportHandler } = require("@a2a-js/sdk/server")
      const transport = new JsonRpcTransportHandler(requestHandler)
      const result = await transport.handle(req.body)
      res.json(result)
    } catch (err) {
      LOG.error(method || "unknown", ">", "failed", err.message)

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal error: " + err.message,
          },
          id: req.body?.id || null,
        })
      }
    }
  })

  LOG.debug("Adapter initialized", { service: srv.name })

  return router
}

/**
 * Mock Executor
 * Returns a completed task with a placeholder response.
 */
const mockExecutor = {
  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext

    const agentMessage = {
      kind: "message",
      messageId: cds.utils.uuid(),
      role: "agent",
      parts: [{ kind: "text", text: "Agent execution not yet implemented." }],
    }

    // Create the task
    eventBus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
    })

    // Mark as working
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    })

    // Publish the response artifact
    eventBus.publish({
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: {
        artifactId: "response",
        name: "Agent Response",
        parts: [{ kind: "text", text: "Agent execution not yet implemented." }],
      },
    })

    // Mark as completed
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "completed",
        message: agentMessage,
        timestamp: new Date().toISOString(),
      },
      final: true,
    })

    eventBus.finished()
  },

  async cancelTask(taskId, eventBus) {
    eventBus.finished()
  },
}
