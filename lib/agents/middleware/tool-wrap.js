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
export function toolWrapMiddleware(srv) {
  return createMiddleware({
    name: "ToolWrapMiddleware",
    wrapToolCall: async function (request, handler) {
      const { name, id, args } = request.toolCall
      try {
        LOG.debug(srv.name, "calling tool", name, args)
        const result = await handler(request)
        if (ToolMessage.isInstance(result) && result.artifact?.isError === true) {
          result.status = "error"
        }
        if (
          ToolMessage.isInstance(result) &&
          result.status !== "error" &&
          typeof result.content === "string" &&
          result.content.startsWith("Error:")
        ) {
          result.status = "error"
        }
        if (result?.status === "error") LOG.debug(srv.name, "tool error", name, result.content)
        return result
      } catch (err) {
        if (isGraphInterrupt(err)) throw err
        LOG.debug(srv.name, "tool error", name, err)
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
