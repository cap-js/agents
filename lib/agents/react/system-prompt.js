import cds from "@sap/cds"
import { getDescription } from "../../utils/utils.js"

export function buildSystemPrompt(srv) {
  const serviceDesc = getDescription(srv.definition) || `Service ${srv.name}`

  return [
    `You are an AI assistant for the "${srv.name}" service.`,
    serviceDesc,
    "",
    "Always use the provided tools to answer questions - do not make up data.",
    "Use the `describe` tool to get information about the service's entities and actions if needed.",
    "Use the `query` tool to read data from entities.",
    cds.env.agent?.per_action_tool !== false
      ? "Call action and function tools directly by name."
      : "Use the `call_action` tool to invoke actions and functions.",
    "Be concise and helpful.",
  ].join("\n")
}

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
