import cds from "@sap/cds"
import { domainToASCII } from "node:url"

import { resolveI18n, getFilteredEntities } from "@cap-js/mcp/lib/utils/tools-shared.js"
export { resolveI18n, getFilteredEntities }

/**
 * Mirrors CAP's internal slug rules used for service path generation.
 */
export const slugified = (name) =>
  /[^.]+$/
    .exec(name)[0]
    .replace(/Service$/, "")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, (_m, c, C) => c + "-" + C)
    .toLowerCase()

// REVISIT: Why do we need this? Why not rely on our own APIs?
export function effectiveDefinition(srv) {
  return cds.context?.model?.definitions?.[srv.name] || srv?.definition
}

/**
 * Resolve an explicitly declared label for a CDS service (i18n label /
 * @Common.Label / @title) — NOT the description or doc comment. Returns undefined
 * when no label is declared, so callers can choose their own fallback.
 */
export function declaredServiceLabel(serviceName, locale) {
  if (!serviceName) return undefined
  locale = locale || cds.context?.locale || "en"
  const model = cds.context?.model ?? cds.model
  const def = model?.definitions?.[serviceName]
  if (!def) return undefined
  return (
    cds.i18n?.labels?.at(def, locale) ||
    resolveI18n(def["@Common.Label"], locale) ||
    resolveI18n(def["@title"], locale) ||
    undefined
  )
}

/**
 * Resolve a display label for a CDS service. Uses the declared label when
 * available, otherwise returns the real (fully-qualified) service name unchanged.
 */
export function serviceLabel(serviceName, locale) {
  if (!serviceName) return undefined
  return declaredServiceLabel(serviceName, locale) || serviceName
}

export function getDescription(def, locale) {
  locale = locale || cds.context?.locale || "en"

  const title =
    cds.i18n?.labels?.at(def, locale) ||
    resolveI18n(def["@Common.Label"], locale) ||
    resolveI18n(def["@title"], locale)

  const description =
    resolveI18n(def["@description"], locale) || resolveI18n(def["@Core.Description"], locale)
  const longDescription = resolveI18n(def["@Core.LongDescription"], locale)

  const parts = [title, description].filter(Boolean)
  if (parts.length === 0 && !longDescription) return def.doc || undefined

  let result = parts.join("\n")

  if (longDescription) {
    result = result ? `${result}\n\n${longDescription}` : longDescription
  }

  return result || undefined
}

/**
 * Classify an (unprefixed) MCP tool name into a status-update kind:
 * "query" (read), "describe" (model introspection), or "action" (everything else).
 */
export function mcpToolKind(rawName) {
  if (rawName === "query" || rawName.endsWith("_query")) return "query"
  if (rawName === "describe" || rawName.endsWith("_describe")) return "describe"
  return "call"
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
  if (!cds.env.requires["audit-log"]) return
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

/**
 * Extract HTTP status and response data from a wrapped AI SDK error wrapped
 * within langchain middleware wraps.
 */
export function extractErrorDetails(err) {
  let current = err
  while (current) {
    // Direct properties (e.g. MiddlewareError that has them)
    if (current.rootCause?.status != null) {
      return Object.assign(current, {
        status: current.rootCause.status,
        data: current.rootCause.response?.data,
      })
    }
    // Check if current error itself is an axios-like response
    if (current.status != null && current.response?.data) {
      return Object.assign(current, { status: current.status, data: current.response.data })
    }
    if (!current.cause) {
      break
    }
    current = current.cause
  }
  return Object.assign(current, { status: current.status, data: current.data })
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
