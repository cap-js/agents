import cds from "@sap/cds"
const LOG = cds.log("agents")

/**
 * Scrub personal data from text before writing to OTel span attributes.
 * Uses the PseudoSession stashed on cds.context by the pseudonymize middleware.
 * No-op when resolveInTraces is true (dev/test) or no session is active.
 */
export function scrubForTrace(text) {
  if (!text) return text
  if (cds.env.agents?.masking?.resolveInTraces) {
    LOG._debug &&
      LOG.debug(
        `Skipping pseudonymization of text in OTEL spans because "cds.env.agents.masking.resolveInTraces" = true`,
      )
    return text
  }
  const session = cds.context?.["_pseudoSession"]
  if (session) {
    return session.scrubText(String(text))
  } else {
    LOG._warn &&
      LOG.warn(
        `Cannot scrub PII from OTEL spans because pseudonymization context is missing on "cds.context"!`,
      )
    return text
  }
}
