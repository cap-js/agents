import { createMiddleware } from "langchain"
import cds from "@sap/cds"

const LOG = cds.log("agents")

export function toolDebugMiddleware() {
  return createMiddleware({
    name: "ToolDebugMiddleware",
    wrapToolCall: async (request, handler) => {
      const { name, args } = request.toolCall
      LOG.debug("[tool]", name, args)
      try {
        const result = await handler(request)
        if (result?.status === "error") LOG.debug("[tool] error", name, result.content)
        else LOG.debug("[tool] completed", name)
        return result
      } catch (err) {
        LOG.debug("[tool] error", name, err)
        throw err
      }
    },
  })
}
