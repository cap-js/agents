import cds from "@sap/cds"
import express from "express"
import { AsyncLocalStorage } from "node:async_hooks"

import { generateAgentCard } from "./protocol/agent-card.js"
import { resolveAgentDir, resolveAgentCardPath } from "./utils/markdown.js"
import { CdsTaskStore } from "./protocol/persistence/task-store.js"
import { CdsPushNotificationStore } from "./protocol/persistence/push-notification-store.js"
import { CdsPushNotificationSender } from "./protocol/push-notification-sender.js"
import preview from "./preview/preview.js"
import { previewAuthChallenge } from "./utils/inner-auth.js"
import { short, audit } from "./utils/utils.js"
import { partsToText } from "./utils/message-handling.js"
import * as metrics from "./telemetry/metrics.js"
import { DefaultRequestHandler } from "@a2a-js/sdk/server"
import { LangGraphExecutor } from "../srv/langgraph-executor-srv.js"

const LOG = cds.log("agents")

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

// Carries the incoming Authorization header across the async boundary created
// by the A2A SDK's fire-and-forget executor pattern.
export const authContext = new AsyncLocalStorage()

export default function A2AProtocolAdapter(srv, options = {}) {
  // Skipping if this is not a service
  if (srv.definition?.kind !== "service") return null

  if (!(srv instanceof cds.ApplicationService) && !options.isSidecar) {
    LOG.debug("Skipping service", { service: srv.name })
    return null
  }

  const router = express.Router()

  // Enforce @requires / @restrict — mirrors HttpAdapter.authorize (cds/lib/srv/protocols/http.js)
  // Uses cds.context.model (not srv.definition) to support feature-toggled annotations.
  // All checks computed per-request (env may change after boot; feature toggles vary per tenant).
  router.use((req, res, next) => {
    const def = cds.context?.model?.definitions?.[srv.name] || srv.definition
    const requires = def?.["@requires"]
    const restrict = def?.["@restrict"]

    let declaredRoles
    if (requires != null) {
      // @requires present — normalize to array
      declaredRoles = Array.isArray(requires) ? requires : [requires]
    } else if (restrict != null) {
      // If no clause carries `to`, fall through to the env fallback below
      // matches CDS core: dev = public, prod = authenticated-user
      declaredRoles = restrict
        .map((r) => r.to)
        .flat()
        .filter(Boolean)
    }

    const roles = declaredRoles?.length
      ? declaredRoles
      : process.env.NODE_ENV === "production" &&
        cds.env.requires?.auth?.restrict_all_services !== false && ["authenticated-user"]

    if (!roles) return next()

    const user = cds.context?.user
    if (user && roles.some((role) => user.has(role))) return next()

    const anonymous = !user || user._is_anonymous
    const status = anonymous ? 401 : 403
    const code = anonymous ? -32001 : -32003
    const msgKey = anonymous ? "UNAUTHORIZED" : "FORBIDDEN"

    if (req.method === "POST") {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code, message: cds.i18n.messages.at(msgKey) },
      })
      res.writeHead(status, { "Content-Type": "application/json" })
      return res.end(body)
    }
    if (status === 401) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Users"' })
    } else {
      res.writeHead(status)
    }
    return res.end()
  })

  const resolved = {
    agentDir: resolveAgentDir(srv),
    agentCardPath: resolveAgentCardPath(srv),
  }

  const agentCard = generateAgentCard(srv, options, resolved)

  // If service is behind a proxy, @Core.Links with rel='via' provides the proxy URL
  const viaLink = srv.definition["@Core.Links"]?.find((l) => l.rel === "via")
  const proxyUrl = viaLink?.href

  // Add "Agent Card" and "Preview" links to the CDS index page
  const linkProviders = (srv.$linkProviders ??= [])
  linkProviders.push((entity, endpoint) => {
    if (entity || endpoint?.kind !== "agent") return undefined
    return {
      href: `${endpoint.path}/.well-known/agent-card.json`,
      name: "Agent Card",
      title: "A2A Agent Card",
    }
  })

  if (cds.env?.server?.index) {
    linkProviders.push((entity, endpoint) => {
      if (entity || endpoint?.kind !== "agent") return undefined
      return {
        href: `${endpoint.path}/preview`,
        name: "Preview",
        title: "Preview in chat UI",
      }
    })
  }

  // Lazy-load SDK, connect to executor, and create request handler.
  // Executor resolved via CDS service pattern — apps customize via
  // buildModel/buildTools/buildSystemPrompt/buildGraph event handlers.
  let _requestHandler = null
  let _executor = null
  async function getRequestHandler() {
    if (_requestHandler) return _requestHandler
    const executor = LangGraphExecutor.for(srv)
    _executor = executor
    const pushEnabled = cds.env.agents?.pushNotifications !== false
    const pushStore = pushEnabled ? new CdsPushNotificationStore() : undefined
    const pushSender = pushStore ? new CdsPushNotificationSender(pushStore) : undefined
    _requestHandler = new DefaultRequestHandler(
      agentCard,
      new CdsTaskStore(),
      executor,
      undefined, // eventBusManager — use SDK default
      pushStore,
      pushSender,
    )
    return _requestHandler
  }

  router.get("/.well-known/agent-card.json", (req, res) => {
    const url = proxyUrl || `${req.protocol}://${req.get("host")}${req.baseUrl}`
    // Regenerate agent card when feature toggles are active (annotations may differ)
    let card
    if (cds.context?.features && Object.keys(cds.context.features).length > 0) {
      const featureResolved = {
        agentDir: resolveAgentDir(srv),
        agentCardPath: resolveAgentCardPath(srv),
      }
      card = { ...generateAgentCard(srv, options, featureResolved), url }
    } else {
      card = { ...agentCard, url }
    }
    if (card.supportedInterfaces) {
      card.supportedInterfaces = card.supportedInterfaces.map((iface) => ({
        ...iface,
        url,
      }))
    }
    res.json(card)
  })

  if (cds.env?.server?.index) {
    router.use("/preview", previewAuthChallenge(srv), preview(agentCard.name || srv.name))
  }

  const inputCap = cds.env.agents?.fileIO?.maxInputFileSizeBytes || 0
  const envelopeLimit = Math.max(5 * 1024 * 1024, inputCap * 2 + 1024 * 1024)
  router.post("/", express.json({ limit: envelopeLimit }), async (req, res) => {
    const t0 = Date.now()
    const method = req.body?.method
    const taskId = req.body?.params?.message?.taskId || req.body?.params?.id || ""
    const contextId = req.body?.params?.message?.contextId || ""
    const requestAttrs = { ...metrics.attrs(srv), "agent.method": method || "unknown" }

    metrics.requestsTotal.add(1, requestAttrs)

    const userText =
      method === "message/send" || method === "message/stream"
        ? partsToText(req.body?.params?.message?.parts)
        : undefined

    // A2A correlation: set task/context IDs on active OTel span + rename.
    const span = metrics.getActiveSpan()
    if (span) {
      span.updateName(`POST /a2a/${srv.name}/`)
      if (cds.context) {
        cds.context["_mlflow.rootSpan"] = span
      }
    }

    if (method === "message/send" || method === "message/stream") {
      const text = userText

      const maxLen = cds.env.agents?.pool?.maxIncomingMessageLength
      if (maxLen > 0 && text?.length > maxLen) {
        LOG.warn("message too long", {
          conversation: short(contextId),
          service: srv.name,
        })
        metrics.errorsTotal.add(1, { ...requestAttrs, "agent.error.code": 400 })

        // Audit: security event for quota breach
        audit("IncomingMessageExceedingLength", {
          data: {
            service: srv.name,
            user: cds.context?.user?.id,
            message: text?.length > 5000 ? text.slice(0, 5000) + "…" : text,
            forwardedIp: req.headers?.["x-forwarded-for"],
          },
          ip: req.ip,
        })

        if (!res.headersSent) {
          res.status(400).json({
            jsonrpc: "2.0",
            // REVISIT: i18n
            error: { code: -32029, message: cds.i18n.messages.at("MESSAGE_TOO_LONG", [maxLen]) },
            id: req.body?.id || null,
          })
        }
        return
      }

      const truncated = text?.length > 80 ? text.slice(0, 80) + "..." : text
      LOG.info("request", {
        conversation: short(contextId),
        service: srv.name,
        method,
        text: truncated,
      })
    } else {
      LOG.debug("request", { conversation: short(contextId), service: srv.name, method })
    }

    try {
      // Quota enforcement — return 429 before SDK processes the request
      // Skip for resume messages (have taskId — already past quota gate)
      if ((method === "message/send" || method === "message/stream") && !taskId) {
        const { default: quotaEnforcerAtStart } =
          await import("./agents/quota-enforcer-at-start.js")
        const quotaResult = await quotaEnforcerAtStart()
        if (quotaResult) {
          LOG.warn("quota exceeded", {
            conversation: short(contextId),
            service: srv.name,
            reason: quotaResult.message,
          })
          metrics.errorsTotal.add(1, { ...requestAttrs, "agent.error.code": 429 })

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
        cds.context["agent.new.task"] = true
      }

      const requestHandler = await getRequestHandler()
      const { JsonRpcTransportHandler } = await import("@a2a-js/sdk/server")
      const transport = new JsonRpcTransportHandler(requestHandler)

      // Abort execution on client disconnect (covers both stream and unary).
      // For new tasks, taskId is empty at registration time — use a mutable
      // ref that gets populated from the result or first SSE event.
      let resolvedTaskId = taskId
      const abortOnClose = () => {
        // Skip when the response ended normally; only fire on real disconnect.
        if (res.writableEnded) return
        if (resolvedTaskId && _executor?.abort) {
          _executor.abort(resolvedTaskId)
        }
      }
      res.on("close", abortOnClose)

      const handleRequest = () => transport.handle(req.body)
      // In sidecar mode the executor fires asynchronously, severing the CDS http
      // context. Run inside authContext so the auth header is forwarded to outbound
      // calls on the remote Java service.
      const result = await (options.isSidecar
        ? authContext.run({ authHeader: req.headers?.authorization }, handleRequest)
        : handleRequest())

      // For unary responses, capture taskId from result (covers new message/send)
      if (!resolvedTaskId && result?.result?.id) {
        resolvedTaskId = result.result.id
      }

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
        // On SSE, also release the async generator on disconnect. The
        // abortOnClose above already handles executor.abort(); this listener
        // adds generator cleanup without duplicating the abort logic.
        res.on("close", () => {
          if (!res.writableEnded) result.return?.()
        })
        try {
          for await (const event of result) {
            // Capture taskId from first event for new tasks
            if (!resolvedTaskId) {
              resolvedTaskId = event?.result?.id || event?.result?.taskId || ""
            }
            res.write(formatSSEEvent(event))
          }
        } catch (streamError) {
          const errMsg = String(streamError?.message ?? streamError) || "Streaming error."
          LOG.error("SSE stream failed", { conversation: short(contextId), error: errMsg })
          metrics.errorsTotal.add(1, { ...requestAttrs, "agent.error.code": -32603 })
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
      LOG.error("request failed", { conversation: short(contextId), method, error: err.message })
      LOG.debug("request failed stack", { conversation: short(contextId), stack: err.stack })

      metrics.errorsTotal.add(1, { ...requestAttrs, "agent.error.code": -32603 })

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

  router.all("/", (_req, res) => {
    res
      .set("Allow", "POST")
      .status(405)
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
  })

  LOG.debug("Adapter initialized", { service: srv.name })

  router.router = router
  return router
}
