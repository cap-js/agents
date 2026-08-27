import cds from "@sap/cds"
import A2AProtocolAdapter, { authContext } from "./index.js"
import { slugified } from "./utils/markdown.js"
import registerDefaultAgentHandlers from "../srv/handlers/index.js"

const LOG = cds.log("a2a")

/**
 * Create an A2A agent router for a CDS service (local or remote).
 *
 * This is the programmatic API for sidecar mode. While the protocol adapter
 * factory is called automatically for local @agent services during cds.serve(),
 * remote services obtained via cds.connect.to() need this explicit API.
 *
 * The returned Express router can be mounted on any Express app.
 *
 * @param {cds.Service} srv - A CDS service instance (local or remote)
 * @param {object} [options] - Options passed to A2AProtocolAdapter
 * @param {string} [options.path] - Override the default mount path
 * @returns {express.Router|null} Express router or null if service is incompatible
 *
 * @example
 *   const { createA2AAgent } = require('@cap-js/a2a/lib/sidecar')
 *   const remoteSrv = await cds.connect.to('CatalogService')
 *   const router = createA2AAgent(remoteSrv)
 *   app.use('/a2a/catalog', router)
 */
function createA2AAgent(srv, options = {}) {
  return A2AProtocolAdapter(srv, { ...options, isSidecar: true })
}

/**
 * Bootstrap A2A sidecar mode.
 *
 * Auto-detects all @agent-annotated services from the loaded model,
 * connects to them, and mounts A2A agent routers on the Express app.
 *
 * Activated via the "a2a-sidecar" CDS profile, which loads A2ASidecarBootstrap
 * whose init() calls this function.
 */
async function bootstrapSidecar() {
  const app = cds.app

  if (!app) {
    LOG.error("Cannot bootstrap agent sidecar: no Express app available")
    return
  }

  const requires = cds.env.requires || {}
  const isNode = cds.env.profiles?.includes("node")

  const agentServices = Object.entries(cds.model?.definitions || {})
    .filter(([, def]) => def.kind === "service" && def["@agent"])
    .map(([cdsName]) => {
      // Use slugified name for Node apps (/hcql/catalog), CDS name for Java apps (/hcql/CatalogService)
      const name = isNode ? slugified(cdsName) : cdsName
      return { name, cdsName, config: requires[name] || { kind: "hcql" } }
    })

  if (agentServices.length === 0) {
    LOG.info("No remote @agent services found for A2A sidecar")
    return
  }

  LOG.info(`Bootstrapping agent sidecar for ${isNode ? "node" : "java"} app`, {
    services: agentServices.map((s) => s.cdsName),
  })

  // Connect to each remote service and mount A2A routers
  await Promise.all(
    agentServices.map(async ({ name, cdsName, config }) => {
      try {
        // Connect to the service
        const srv = await cds.connect.to(name)

        // When connected via slugified name (Node apps), restore the CDS name and model
        // so tools and agent card generation work against the correct definition.
        if (isNode) {
          srv.name = cdsName
          srv.model = cds.model
          delete srv.definition
          delete srv.entities
          delete srv.actions
          delete srv.operations
        }

        // Register default agent handlers (buildGraph, buildTools, buildModel, etc.)
        // normally done by the cds "serving" hook, which only fires for ApplicationServices.
        registerDefaultAgentHandlers(srv)

        // Attach "before":
        // Forward the incoming Authorization header to all outbound calls on this service.
        // We use our own AsyncLocalStorage (authContext) because the A2A SDK fires the
        // executor asynchronously, which severs the CDS http context (cds.context.http).
        srv.before("*", (req) => {
          const authHeader = authContext.getStore()?.authHeader
          if (authHeader) req.headers = { ...req.headers, authorization: authHeader }
        })

        // Apply the HCQL actions patch only for Java main apps.
        // Java's HCQL adapter requires the envelope format {"event":"<action>","args":[...]},
        // but Node.js HCQL accepts the standard CDS remote format directly.
        // Enable via cds.env.agent._javaHcqlCompat (set automatically by --profile java).
        if ((!config.kind || config.kind === "hcql") && !isNode && cds.env.agent?._javaHcqlCompat) {
          _patchHcqlActions(srv)
        }

        // Add service with its sluggified name
        const path = config.a2aPath || `/a2a/${slugified(cdsName)}`
        const router = createA2AAgent(srv, { path })

        if (router) {
          app.use(path, cds.middlewares.before, router)
          LOG.info("Mounted agent", { service: cdsName, path })
        } else {
          LOG.warn("Could not create agent for service", { service: cdsName })
        }
      } catch (err) {
        LOG.error("Failed to create agent for remote service", {
          service: cdsName,
          error: err.message,
        })
      }
    }),
  )
}

export { createA2AAgent, bootstrapSidecar }

// _patchHcqlActions patches actions and functions to use the HCQL envelope format
// {"event":"<action>","args":[{...}]} posted to the service root.
// Necessary because @sap/cds/libx/_runtime/remote/Service.js (v9.9.1) sends:
//   - actions as REST-style POST /<action> with data as body
//   - functions as OData-style GET /<function>(param=@param)?@param=value
// The Java HCQL adapter rejects both formats.
// This patch may be removed once the Java HCQL accepts the format sent by Service.js.
//
// No recursion risk: srv.on(opName, ...) only fires for the action event (e.g. "submitOrder"),
// while srv.send({ method: "POST", path: "/" }) dispatches as "POST /" — a different event key.
function _patchHcqlActions(srv) {
  const model = srv.model || cds.model
  const actions = Object.entries(model.definitions)
    .filter(
      ([n, def]) =>
        n.startsWith(srv.name + ".") && (def.kind === "action" || def.kind === "function"),
    )
    .map(([n]) => n.slice(srv.name.length + 1))

  srv.prepend(() => {
    for (const opName of actions) {
      srv.on(opName, async (req) => {
        const result = await srv.send({
          method: "POST",
          path: "/",
          headers: req.headers,
          data: { event: opName, args: [req.data] },
        })
        req.reply(result)
      })
    }
  })
}
