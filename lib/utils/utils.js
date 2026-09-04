import cds from "@sap/cds"
import { domainToASCII } from "node:url"
import { slugified } from "./markdown.js"

function resolveI18n(value, locale) {
  if (!value) return undefined
  const match = /{i18n>([^}]+)}/.exec(value)
  if (match) {
    return cds.i18n?.labels?.texts4?.(locale)?.[match[1]] || value
  }
  return value
}

export function getAgentLogger(srv) {
  const slug = slugified(srv.name)
  const agentSlug = slug.endsWith("-agent") ? slug : `${slug}-agent`
  return cds.log("agents:" + srv.name, { label: agentSlug })
}

export function getDescription(obj, locale) {
  locale = locale || cds.context?.locale || "en"

  const title =
    cds.i18n?.labels?.at(obj, locale) ||
    resolveI18n(obj["@Common.Label"], locale) ||
    resolveI18n(obj["@title"], locale)

  const description =
    resolveI18n(obj["@Core.Description"], locale) || resolveI18n(obj["@description"], locale)

  const longDescription = resolveI18n(obj["@Core.LongDescription"], locale)

  const parts = [title, description].filter(Boolean)
  if (parts.length === 0 && !longDescription) return obj.doc || undefined

  let result = parts.join("\n")

  if (longDescription) {
    result = result ? `${result}\n\n${longDescription}` : longDescription
  }

  return result || undefined
}

export function getFilteredEntities(srv) {
  return Object.fromEntries(
    Object.entries(srv.entities || {})
      .filter(
        ([name, entity]) =>
          !(entity["@cds.autoexposed"] && !entity["@cds.autoexpose"]) &&
          !name.endsWith("DraftAdministrativeData") &&
          !name.endsWith(".texts") &&
          !entity["@cds.api.ignore"],
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function getFilteredActions(srv) {
  const actions = {}
  for (const op of srv.actions || []) {
    if ((op.kind === "action" || op.kind === "function") && !op["@cds.api.ignore"]) {
      const localName = op.name.split(".").pop()
      actions[localName] = op
    }
  }
  return actions
}

/**
 * Sanitize an agent name into a valid LangChain/LLM tool name.
 */
export function toolName(rawName) {
  return rawName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .toLowerCase()
    .replace(/^[^a-z]/, (c) => `_${c}`) // ensure first char is a letter (some LLM APIs reject otherwise)
    .slice(0, 60)
}

/**
 * Shorten a UUID/ID to first 8 characters for log readability.
 */
export function short(id) {
  return id?.slice(0, 8) || "-"
}

/**
 * Emit an audit log event (fire-and-forget).
 * All events are mapped to SecurityEvent for compatibility with SAP Audit Log Service.
 * The original event name is preserved in data.data.event for forensic analysis.
 * Includes cds.context.id as correlationId for cross-referencing with auto-emitted
 * DPP events (e.g., SensitiveDataRead triggered by tool entity access).
 * Never blocks execution. Logs warning on failure.
 */
export function audit(event, data) {
  if (!cds.requires["audit-log"]) return
  cds.connect
    .to("audit-log")
    .then((a) =>
      a.log("SecurityEvent", {
        data: { event, correlationId: cds.context?.id, ...data.data },
        ip: data.ip,
      }),
    )
    .catch((err) => {
      const LOG = cds.log("agents|audit")
      LOG.warn("audit emit failed", { event, error: err.message })
    })
}

const ALLOWED_PROTOCOLS = ["http:", "https:"]

/**
 * Validates that a URL belongs to one of the allowed domains.
 * Handles subdomains, punycode normalization, protocol validation.
 * Returns true if URL's hostname matches or is a subdomain of any allowed domain.
 * Returns false for invalid URLs, non-HTTP(S) protocols, or domain mismatch.
 */
export function isAllowedDomain(untrustedUrl, allowedDomains) {
  if (!untrustedUrl || !allowedDomains?.length) return false

  let hostname
  try {
    const parsed = new URL(untrustedUrl)
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return false
    hostname = parsed.hostname
    if (!hostname) return false
  } catch {
    return false
  }

  for (const domain of allowedDomains) {
    const normalized = domainToASCII(domain)
    if (!normalized) continue
    if (hostname === normalized) return true
    if (hostname.endsWith("." + normalized)) return true
  }

  return false
}

export const ms4 =
  cds.utils.ms4 ||
  ((val) => {
    if (typeof val === "number") return val
    const m = /^(\d+)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hrs|hours?|d|days?|w|weeks?)?$/i.exec(
      String(val),
    )
    if (!m) return Number(val) || 0
    const n = Number(m[1])
    const unit = (m[2] || "ms").toLowerCase()
    const factors = {
      ms: 1,
      s: 1000,
      sec: 1000,
      second: 1000,
      seconds: 1000,
      m: 60000,
      min: 60000,
      minute: 60000,
      minutes: 60000,
      h: 3600000,
      hrs: 3600000,
      hour: 3600000,
      hours: 3600000,
      d: 86400000,
      day: 86400000,
      days: 86400000,
      w: 604800000,
      week: 604800000,
      weeks: 604800000,
    }
    return n * (factors[unit] || 1)
  })
