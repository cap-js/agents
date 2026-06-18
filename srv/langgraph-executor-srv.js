import cds from "@sap/cds"
import { GraphExecutor } from "./handlers/graph-executor.js"
import { GraphCache, hashFeatures } from "./graph-cache.js"

const LOG = cds.log("agent")

/**
 * LangGraph-based executor service for @agent annotated services.
 *
 * Dispatches `buildGraph` event on the target ApplicationService.
 * Graphs cached per feature vector (cds.context.features) in a FIFO cache.
 * Lazy init: graph built on first request (features not available at startup).
 */
export default class LangGraphExecutorService extends cds.Service {
  async init() {
    this._caches = new Map()

    this.on("computeActiveUsers", async () => {
      const { computeActiveUsers } = await import("../lib/telemetry/active-users.js")
      await computeActiveUsers()
    })

    return super.init()
  }

  for(srv) {
    return {
      execute: (requestContext, eventBus) => this._execute(srv, requestContext, eventBus),
      cancelTask: async (taskId, eventBus) => {
        const executor = await this._ensureExecutor(srv)
        return executor.cancelTask(taskId, eventBus)
      },
    }
  }

  _getCache(srv) {
    if (!this._caches.has(srv.name)) {
      this._caches.set(srv.name, new GraphCache())
    }
    return this._caches.get(srv.name)
  }

  async _ensureExecutor(srv) {
    const features = cds.context?.features || {}
    const key = hashFeatures(features)
    const cache = this._getCache(srv)

    return cache.getOrBuild(key, () => this._buildExecutor(srv))
  }

  async _buildExecutor(srv) {
    const result = await srv.send("buildGraph", {})

    if (result && typeof result.invoke === "function") {
      return new GraphExecutor(result, srv)
    }
    if (result && typeof result.execute === "function") {
      return result
    }

    throw new Error(
      `buildGraph handler for service "${srv.name}" must return a compiled LangGraph (with invoke()) ` +
        `or a GraphExecutor (with execute()). Got: ${typeof result}`,
    )
  }

  async _execute(srv, requestContext, eventBus) {
    const executor = await this._ensureExecutor(srv)
    return executor.execute(requestContext, eventBus)
  }
}
