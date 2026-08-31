import cds from "@sap/cds"
import { createHash, randomBytes } from "node:crypto"

const STATE = "cap.agent.PseudonymizationState"
const MAPPINGS = "cap.agent.PseudonymizationMappings"
const LOG = cds.log("agents")

const _cache = new Map()

// Cache key includes tenant to never share in-memory sessions.
function _cacheKey(threadId) {
  return `${cds.context?.tenant ?? "_"}:${threadId}`
}

export class PseudoSession {
  constructor(threadId, seed, existing = new Map()) {
    this._threadId = threadId
    this._seed = seed
    this._hashToOriginal = new Map(existing)
    this._originalToHash = new Map()
    this._newMappings = new Map()
    for (const [hash, original] of existing) {
      this._originalToHash.set(String(original), hash)
    }
    this._sortedOriginalPairs = null
  }

  static async loadOrCreate(threadId) {
    const key = _cacheKey(threadId)
    if (_cache.has(key)) return _cache.get(key)
    try {
      const row = await SELECT.one.from(STATE).where({ threadId }).columns(s => {
        s.seed,
        s.mappings(m => { m.hash, m.original })
      })
      if (row) {
        const existing = new Map((row.mappings ?? []).map(r => [r.hash, r.original]))
        const session = new PseudoSession(threadId, row.seed, existing)
        _cache.set(key, session)
        return session
      }
      const seed = randomBytes(16).toString("hex")
      await INSERT.into(STATE).entries({ threadId, seed })
      const session = new PseudoSession(threadId, seed)
      _cache.set(key, session)
      return session
    } catch (err) {
      LOG.warn("PseudoSession.loadOrCreate failed — pseudonymization disabled for this session", {
        threadId, error: err.message,
      })
      return null
    }
  }

  static load(threadId) { return _cache.get(_cacheKey(threadId)) ?? null }
  static evict(threadId) { _cache.delete(_cacheKey(threadId)) }

  pseudonymize(value, propertyName) {
    const str = String(value)
    if (this._originalToHash.has(str)) return this._originalToHash.get(str)
    const suffix = createHash("sha1").update(this._seed + str).digest("hex").slice(0, 8)
    const hash = `${propertyName}_${suffix}`
    this._hashToOriginal.set(hash, str)
    this._originalToHash.set(str, hash)
    this._newMappings.set(hash, str)
    // Invalidate sorted cache; rebuilt lazily on next scrub.
    this._sortedOriginalPairs = null
    return hash
  }

  resolve(hash) { return this._hashToOriginal.get(hash) ?? hash }

  resolveText(text) {
    if (!text || !this._hashToOriginal.size) return text
    // Hashes are fixed-shape ("prefix_8hex") and never a substring of each other
    let result = String(text)
    for (const [hash, original] of this._hashToOriginal) result = result.replaceAll(hash, original)
    return result
  }

  scrubText(text) {
    if (!text || !this._originalToHash.size) return text
    // Replace longest originals first so a shorter original that is a substring
    // of a longer one (e.g. "Emily" vs "Emily Brontë") does not corrupt it.
    this._sortedOriginalPairs ??= [...this._originalToHash].sort((a, b) => b[0].length - a[0].length)
    let result = String(text)
    for (const [original, hash] of this._sortedOriginalPairs) result = result.replaceAll(original, hash)
    return result
  }

  async flush() {
    if (!this._newMappings.size) return
    const entries = [...this._newMappings.entries()].map(([hash, original]) => ({
      threadId: this._threadId, hash, original,
    }))
    try {
      await UPSERT.into(MAPPINGS).entries(entries)
      this._newMappings.clear()
    } catch (err) {
      LOG.warn("PseudoSession.flush failed", { threadId: this._threadId, error: err.message })
    }
  }
}
