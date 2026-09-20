import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { PseudoSession } from "../../pseudonymize/store.js"
import {
  hasPersonalDataAnnotations,
  resolveArgs,
  pseudonymizationThreadId,
  pseudonymizeToolResult,
} from "../../pseudonymize/helpers.js"

function threadIdFromContext() {
  return pseudonymizationThreadId(cds.context?.["agent.service"], cds.context?.["agent.context.id"])
}

export function pseudonymizeMiddleware(srv) {
  if (!cds.env.agents?.masking) return null

  return createMiddleware({
    name: "pseudonymize",

    // Once per run: gate on annotations, load session, stash it on cds.context.
    beforeAgent: async () => {
      const model = cds.context?.model ?? srv.model
      if (!hasPersonalDataAnnotations(model, srv.name)) return
      const session = await PseudoSession.loadOrCreate(threadIdFromContext())
      if (session) cds.context._pseudoSession = session
    },

    wrapToolCall: async (request, handler) => {
      const session = cds.context?._pseudoSession
      if (!session) return handler(request)

      const toolName = request.toolCall?.name
      const toolArgs = request.toolCall?.args ?? {}
      const resolvedArgs = resolveArgs(toolArgs, session)
      const resolvedRequest =
        resolvedArgs !== toolArgs
          ? { ...request, toolCall: { ...request.toolCall, args: resolvedArgs } }
          : request

      const toolMessage = await handler(resolvedRequest)

      let outMessage = toolMessage
      if (toolMessage?.content) {
        const content = await pseudonymizeToolResult({
          content: toolMessage.content,
          toolName,
          cql: toolArgs.cql,
        })
        if (content !== toolMessage.content) {
          const { ToolMessage } = await import("@langchain/core/messages")
          outMessage = new ToolMessage({ ...toolMessage, content })
        }
      }

      return outMessage
    },
  })
}
