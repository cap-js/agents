import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"
import { isGraphInterrupt } from "@langchain/langgraph"
import cds from "@sap/cds"

const LOG = cds.log("agents")

/**
 * Converts tool errors into error ToolMessages so the LLM can retry.
 * Handles two paths: thrown errors (err.details appended when present)
 * and tools returning artifact.isError=true (@cap-js/mcp action pattern).
 */
export function toolWrapMiddleware() {
  return createMiddleware({
    name: "ToolWrapMiddleware",
    wrapToolCall: async (request, handler) => {
      const { name, id } = request.toolCall
      try {
        const result = await handler(request)
        if (ToolMessage.isInstance(result) && result.artifact?.isError === true) {
          result.status = "error"
        }
        if (result?.status === "error") LOG.debug("[tool] error", name, result.content)
        else LOG.debug("[tool] completed", name)
        return result
      } catch (err) {
        if (isGraphInterrupt(err)) throw err
        LOG.debug("[tool] error", name, err)
        let content = `Error: ${err.message}`
        if (Array.isArray(err.details) && err.details.length > 0) {
          const lines = err.details.map((d) => `- ${d.message}`).join("\n")
          content += `\n${lines}`
        }
        return new ToolMessage({
          content,
          tool_call_id: id ?? "",
          name,
          status: "error",
        })
      }
    },
  })
}
