const cds = require("@sap/cds")
const { getDescription } = require("./utils")

/**
 * Build a system prompt for the LLM.
 *
 * Kept minimal — entity schemas, action parameters, and descriptions
 * are already visible to the LLM through the tool definitions.
 * The system prompt only provides identity, service context, and behavioral rules.
 *
 * @param {import('@sap/cds').Service} srv - The CDS service instance
 * @returns {string} System prompt text
 */
function buildSystemPrompt(srv) {
  const serviceDesc = getDescription(srv.definition) || `Service ${srv.name}`

  return [
    `You are an AI assistant for the "${srv.name}" service.`,
    serviceDesc,
    "",
    "Always use the provided tools to answer questions - do not make up data.",
    "Use the `describe` tool to get information about the service's entities and actions if needed.",
    "Use the `query` tool to read data from entities.",
    cds.env.a2a?.per_action_tool !== false
      ? "Call action and function tools directly by name."
      : "Use the `call_action` tool to invoke actions and functions.",
    "Be concise and helpful.",
  ].join("\n")
}

/**
 * Construct a spec-compliant A2A Message object.
 *
 * @param {string} text - The message text content
 * @returns {object} A2A Message object
 */
function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}

module.exports = { buildSystemPrompt, agentMessage }
