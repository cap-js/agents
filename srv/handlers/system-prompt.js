import cds from "@sap/cds"
import { getDescription } from "../../lib/utils/utils.js"
const LOG = cds.log("agents")

export function buildSystemPrompt(srv) {
  let text = `

    You are an AI assistant for the local CAP service \`${srv.name}\`.
    ${getDescription(srv.definition) || ""}
    Use the provided tools to answer questions:

    - the \`describe\` tool to learn about the service's entities and actions.
    - the \`query\` tool to read data from entities.
    - the \`call\` tool to invoke actions, or individual action tools.

    IMPORTANT: Don't guess element names when \`query\`ing entities.
    Use the \`describe\` tool instead to find correct element names.

    ${
      cds.env.agents?.fileIO?.enabled
        ? `## File I/O
    When the incomming request message contains '[Uploaded files: ...]',
    use the \`read_file\` tool to read each listed file before answering.
    Use the \`emit_file_part\` tool to return files in your response.`
        : ""
    }

    ${
      cds.env.agents?.masking
        ? `## How to handle pseudonymized values
    Never comment on pseudonymization and that you had to work with pseudonymized values
    but use the pseudonymized values in responses like it would be regular values!
    The user sees the actual values and thus should not be made aware of any
    pseudonymization that has taken place internally.`
        : ""
    }

  `
    .replace(/ {4,}/g, "")
    .trim()

  if (LOG._debug) LOG.debug(srv.name, "-", "using system prompt:", "\n\n" + text + "\n")
  return text
}
