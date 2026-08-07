/**
 * A2A message part utilities — handle both wire formats:
 *
 * v0.3.x (kind-based): {kind:"text",text} | {kind:"file",file:{bytes|uri,mimeType}} | {kind:"data",data}
 * v1.0   (oneOf):      {content:{$case:"text"|"raw"|"url"|"data", value}, mediaType, filename}
 */

/**
 * Extract plain text from A2A parts. Data parts → JSON.stringify. File parts skipped.
 * @param {Array} parts
 * @returns {string}
 */
export function partsToText(parts = []) {
  return (
    parts
      .map((p) => {
        if (p.content?.$case === "text") return p.content.value || ""
        if (p.content?.$case === "data") return JSON.stringify(p.content.value)
        // REVISIT: remove when @a2a-js/sdk pinned to ^1.x (SDK normalizes to content.$case)
        if (p.kind === "text" || (!p.kind && p.text)) return p.text || ""
        if (p.kind === "data" && p.data !== undefined) return JSON.stringify(p.data)
        return null
      })
      .filter((v) => v !== null)
      .join(" ") || ""
  )
}

/**
 * Return the raw `data` object of the FIRST DataPart in `parts`, or undefined if none.
 * Handles both wire shapes (v0.3 kind-based, v1.0 oneOf), mirroring partsToText.
 * Opaque — the object is returned as-is (no clone, no validation).
 * @param {Array} parts
 * @returns {object | undefined}
 */
export function firstDataPart(parts = []) {
  for (const p of parts) {
    // Nullish values are not a valid DataPart payload (spec: `data` is always an object).
    // Returning undefined lets the call-site fall through to the text parser instead of
    // treating a falsy `null` as a real resume value.
    if (p.content?.$case === "data" && p.content.value != null) return p.content.value
    // REVISIT: remove when @a2a-js/sdk pinned to ^1.x (SDK normalizes to content.$case)
    if (p.kind === "data" && p.data != null) return p.data
  }
  return undefined
}

const IMAGE_MIME_RE = /^image\//

/**
 * Map A2A parts to LangChain-JS / OpenAI content value for MLflow span inputs.
 *
 * Single text part → plain string. Otherwise array of content blocks:
 *   text/data → {type:"text", text}
 *   image/*   → {type:"image_url", image_url:{url:"data:<mime>;base64,..."|"<uri>"}}
 *   other files → {type:"text", text:"[file: <name> (<mime>)]"}
 *
 * @param {Array} parts
 * @returns {string | Array}
 */
export function partsToMessageContent(parts = []) {
  const blocks = []
  for (const p of parts) {
    // v1.0 oneOf
    if (p.content?.$case) {
      switch (p.content.$case) {
        case "text":
          blocks.push({ type: "text", text: p.content.value || "" })
          break
        case "url": {
          const mime = p.mediaType || ""
          if (IMAGE_MIME_RE.test(mime)) {
            blocks.push({ type: "image_url", image_url: { url: p.content.value } })
          } else {
            const label = p.filename
              ? `[file: ${p.filename} (${mime || "unknown"})]`
              : p.content.value
            blocks.push({ type: "text", text: label })
          }
          break
        }
        case "raw": {
          const mime = p.mediaType || "application/octet-stream"
          const b64 = Buffer.isBuffer(p.content.value)
            ? p.content.value.toString("base64")
            : p.content.value
          if (IMAGE_MIME_RE.test(mime)) {
            blocks.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } })
          } else {
            blocks.push({ type: "text", text: `[file: ${p.filename || "attachment"} (${mime})]` })
          }
          break
        }
        case "data":
          blocks.push({ type: "text", text: JSON.stringify(p.content.value, null, 2) })
          break
        default:
          break
      }
      continue
    }
    // REVISIT: remove when @a2a-js/sdk pinned to ^1.x (SDK normalizes to content.$case)
    // v0.3.x kind-based
    if (p.kind === "text" || (!p.kind && p.text)) {
      blocks.push({ type: "text", text: p.text || "" })
    } else if (p.kind === "file") {
      const f = p.file || p
      const mime = f.mimeType || "application/octet-stream"
      if (f.bytes) {
        if (IMAGE_MIME_RE.test(mime)) {
          blocks.push({ type: "image_url", image_url: { url: `data:${mime};base64,${f.bytes}` } })
        } else {
          blocks.push({ type: "text", text: `[file: ${f.name || "attachment"} (${mime})]` })
        }
      } else if (f.uri) {
        if (IMAGE_MIME_RE.test(mime)) {
          blocks.push({ type: "image_url", image_url: { url: f.uri } })
        } else {
          blocks.push({ type: "text", text: `[file: ${f.name || f.uri} (${mime})]` })
        }
      }
    } else if (p.kind === "data" && p.data !== undefined) {
      blocks.push({ type: "text", text: JSON.stringify(p.data, null, 2) })
    }
  }
  if (blocks.length === 0) return ""
  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text
  return blocks
}

/**
 * Build OpenAI-format chat messages from A2A conversation history + current message.
 *
 * A2A roles → OpenAI roles:
 *   "user" | "ROLE_USER" | 1 → "user"
 *   "agent" | "ROLE_AGENT" | 2 → "assistant"
 *
 * Uses history when available (SDK appends current message to it before execute()),
 * falls back to current message only for new tasks.
 *
 * @param {object} requestContext
 * @returns {Array<{role:string, content:string|Array}>}
 */
export function buildChatMessages(requestContext) {
  const history = requestContext.task?.history || []
  const current = requestContext.userMessage
  const a2aMessages = history.length > 0 ? history : [current]

  function toOaiRole(role) {
    if (role === "agent" || role === "ROLE_AGENT" || role === 2) return "assistant"
    return "user"
  }

  return a2aMessages.filter(Boolean).map((msg) => ({
    role: toOaiRole(msg.role),
    content: partsToMessageContent(msg.parts || []),
  }))
}
