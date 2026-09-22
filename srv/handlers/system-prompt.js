import cds from "@sap/cds"
import { getDescription } from "../../lib/utils/utils.js"

export function buildSystemPrompt(srv) {
  const serviceDesc = getDescription(srv.definition) || `Service ${srv.name}`

  return [
    `You are an AI assistant for the "${srv.name}" service.`,
    serviceDesc,
    "",
    "Always use the provided tools to answer questions - do not make up data.",
    "Use the `describe` tool to get information about the service's entities and actions if needed.",
    "Use the `query` tool to read data from entities.",
    cds.env.agents?.per_action_tool !== false
      ? "Call action and function tools directly by name."
      : "Use the `call` tool to invoke actions and functions.",
    ...(cds.env.agents?.fileIO?.enabled
      ? [
          "When the user's message contains '[Uploaded files: ...]', use the `read_file` tool to read each listed file before answering.",
          "Use `emit_file_part` to return files in your response.",
        ]
      : []),
    "Be concise and helpful.",
    ...(cds.env.agents?.masking
      ? [
          `## How to handle pseudonymized values`,
          `Never comment on pseudonymization and that you had to work with pseudonymized values but use the pseudonymized values in responses like it would be regular values!`,
          `The user sees the actual values and thus should not be made aware of any pseudonymization that has taken place internally.`,
        ]
      : []),
  ].join("\n")
}
