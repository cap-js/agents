import { createHash, randomBytes } from "node:crypto"

export function generatePseudonymTag(seed, value, category) {
  const hash = createHash("sha256")
    .update(seed + String(value))
    .digest("hex")
    .slice(0, 8)
  return `${category}-${hash}`
}

export class PseudonymStore {
  constructor(seed, existing = new Map()) {
    this._seed = seed ?? randomBytes(16).toString("hex")
    this._hashToOriginal = new Map(existing)
    this._originalToHash = new Map()
    // Sort by descending key length so tags ("name-abc12345") are processed
    // before bare hashes ("abc12345") and win in _originalToHash.
    for (const [hash, original] of [...existing].sort((a, b) => b[0].length - a[0].length)) {
      const str = String(original)
      if (!this._originalToHash.has(str)) this._originalToHash.set(str, hash)
    }
    this._sortedOriginalPairs = null
    this._sortedHashPairs = null
  }

  pseudonymize(value, propertyName) {
    const str = String(value)
    if (this._originalToHash.has(str)) return this._originalToHash.get(str)
    const tag = generatePseudonymTag(this._seed, str, propertyName)
    const hash = tag.slice(propertyName.length + 1)
    this._hashToOriginal.set(tag, str)
    this._hashToOriginal.set(hash, str)
    this._originalToHash.set(str, tag)
    // Invalidate sorted cache; rebuilt lazily on next scrub.
    this._sortedOriginalPairs = null
    this._sortedHashPairs = null
    return tag
  }

  addMappings(mappings) {
    if (!mappings?.length) return
    // Sort by descending key length so tags ("name-abc12345") win over bare hashes ("abc12345").
    const sorted = [...mappings].sort((a, b) => b[0].length - a[0].length)
    for (const [hash, original] of sorted) {
      const str = String(original)
      const key = String(hash)
      if (!str || !key || str === key) continue
      if (!this._hashToOriginal.has(key)) this._hashToOriginal.set(key, str)
      if (!this._originalToHash.has(str)) this._originalToHash.set(str, key)
    }
    this._sortedOriginalPairs = null
    this._sortedHashPairs = null
  }

  resolve(hash) {
    return this._hashToOriginal.get(hash) ?? hash
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
