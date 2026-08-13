import cds from "@sap/cds"
import crypto from "crypto"

const LOG = cds.log("agents")

/**
 * Compute a stable hash key from cds.context.features.
 * Returns empty string for empty/undefined features (default graph).
 */
export function hashFeatures(features) {
  if (!features || typeof features !== "object") return ""
  const keys = Object.keys(features).sort()
  if (keys.length === 0) return ""
  const normalized = JSON.stringify(keys.map((k) => [k, features[k]]))
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

/**
 * FIFO cache for compiled LangGraph executors keyed by feature vector hash.
 * Eviction: oldest entry removed when full.
 * Dedup: promise map prevents parallel builds for same key.
 */
export class GraphCache {
  constructor() {
    this._maxSize = cds.env.agents?.graphCacheSize || 20
    this._cache = new Map()
    this._building = new Map()
  }

  get size() {
    return this._cache.size
  }

  has(key) {
    return this._cache.has(key)
  }

  get(key) {
    return this._cache.get(key)
  }

  set(key, executor) {
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      const oldest = this._cache.keys().next().value
      this._cache.delete(oldest)
      LOG.debug("Cache evicted", { key: oldest })
    }
    this._cache.set(key, executor)
  }

  async getOrBuild(key, factory) {
    if (this._cache.has(key)) return this._cache.get(key)
    if (this._building.has(key)) return this._building.get(key)

    // Store promise BEFORE invoking factory to prevent TOCTOU race on same tick
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    this._building.set(key, promise)

    factory()
      .then((executor) => {
        this.set(key, executor)
        resolve(executor)
      })
      .catch((err) => {
        reject(err)
      })
      .finally(() => {
        this._building.delete(key)
      })

    return promise
  }

  clear() {
    this._cache.clear()
    this._building.clear()
  }
}
