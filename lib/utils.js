const cds = require("@sap/cds")

function resolveI18n(value, locale) {
  if (!value) return undefined
  const match = /{i18n>([^}]+)}/.exec(value)
  if (match) {
    return cds.i18n?.labels?.texts4?.(locale)?.[match[1]] || value
  }
  return value
}

function getDescription(obj, locale) {
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

function getFilteredEntities(srv) {
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

function getFilteredActions(srv) {
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
 * Shorten a UUID/ID to first 8 characters for log readability.
 */
function short(id) {
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
function audit(event, data) {
  cds.connect
    .to("audit-log")
    .then((a) =>
      a.log("SecurityEvent", {
        data: { event, correlationId: cds.context?.id, ...data.data },
        ip: data.ip,
      }),
    )
    .catch((err) => {
      const LOG = cds.log("a2a|audit")
      LOG.warn("audit emit failed", { event, error: err.message })
    })
}

module.exports = {
  short,
  audit,
  getDescription,
  getFilteredEntities,
  getFilteredActions,
}
