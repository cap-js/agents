import cds from "@sap/cds"

/**
 * Construct a spec-compliant A2A Message object.
 */
export function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}
