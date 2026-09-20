import cds from "@sap/cds"
import { createHash, randomBytes } from "node:crypto"

const _cache = new Map()
export const PSEUDONYMIZATION_STATE_CHANNEL = "__cap_agent_pseudonymization"

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
    for (const [hash, original] of existing) {
      this._originalToHash.set(String(original), hash)
    }
    this._sortedOriginalPairs = null
    this._sortedHashPairs = null
  }

  static async loadOrCreate(threadId) {
    const key = _cacheKey(threadId)
    if (_cache.has(key)) return _cache.get(key)
    const state = await this._loadGraphState()
    const existing = new Map(state?.mappings ?? [])
    const session = new PseudoSession(
      threadId,
      state?.seed ?? randomBytes(16).toString("hex"),
      existing,
    )
    _cache.set(key, session)
    return session
  }

  static async _loadGraphState() {
    const checkpointer = cds.context?.["agent.checkpointer"]
    const thread_id = cds.context?.["agent.graph.thread_id"]
    try {
      const tuple = await checkpointer.getTuple({ configurable: { thread_id } })
      return tuple?.checkpoint?.channel_values?.[PSEUDONYMIZATION_STATE_CHANNEL] ?? null
    } catch {
      return null
    }
  }

  static load(threadId) {
    return _cache.get(_cacheKey(threadId)) ?? null
  }
  static evict(threadId) {
    _cache.delete(_cacheKey(threadId))
  }

  pseudonymize(value, propertyName) {
    const str = String(value)
    if (this._originalToHash.has(str)) return this._originalToHash.get(str)
    const hash = createHash("sha1")
      .update(this._seed + str)
      .digest("hex")
      .slice(0, 8)
    const tag = `${propertyName}-${hash}`
    this._hashToOriginal.set(tag, str)
    this._hashToOriginal.set(hash, str)
    this._originalToHash.set(str, tag)
    // Invalidate sorted cache; rebuilt lazily on next scrub.
    this._sortedOriginalPairs = null
    this._sortedHashPairs = null
    return tag
  }

  remember(original, pseudonym) {
    const str = String(original)
    const hash = String(pseudonym)
    if (!str || !hash || str === hash) return hash
    if (this._hashToOriginal.has(hash)) return hash
    this._hashToOriginal.set(hash, str)
    this._originalToHash.set(str, hash)
    this._sortedOriginalPairs = null
    this._sortedHashPairs = null
    return hash
  }

  resolve(hash) {
    return this._hashToOriginal.get(hash) ?? hash
  }

  state() {
    return { seed: this._seed, mappings: [...this._hashToOriginal] }
  }

  resolveText(text) {
    if (!text || !this._hashToOriginal.size) return text
    // tag and ID are registered. First go for tags then ID, else artefacts are left in text
    this._sortedHashPairs ??= [...this._hashToOriginal].sort((a, b) => b[0].length - a[0].length)
    let result = String(text)
    for (const [hash, original] of this._sortedHashPairs) result = result.replaceAll(hash, original)
    return result
  }

  scrubText(text) {
    if (!text || !this._originalToHash.size) return text
    // Replace longest originals first so a shorter original that is a substring
    // of a longer one (e.g. "Emily" vs "Emily Brontë") does not corrupt it.
    this._sortedOriginalPairs ??= [...this._originalToHash].sort(
      (a, b) => b[0].length - a[0].length,
    )
    let result = String(text)
    for (const [original, hash] of this._sortedOriginalPairs)
      result = result.replaceAll(original, hash)
    return result
  }
}
