import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { PseudoSession } from "../../pseudonymize/store.js"
import {
  hasPersonalDataAnnotations,
  resolveArgs,
  scrubToolCallResult,
  SESSION_KEY,
} from "../../pseudonymize/helpers.js"

function threadIdFromContext() {
  return `${cds.context?.["agent.service"]}:${cds.context?.["agent.context.id"]}`
}

export function pseudonymizeMiddleware(srv) {
  if (cds.env.agents?.masking === false) return null

  return createMiddleware({
    name: "pseudonymize",

    // Once per run: gate on annotations, load session, stash it on cds.context.
    // The wraps + tool-tracing read it from there via SESSION_KEY.
    beforeAgent: async () => {
      const model = cds.context?.model ?? srv.model
      if (!hasPersonalDataAnnotations(model, srv.name)) return
      const session = await PseudoSession.loadOrCreate(threadIdFromContext())
      if (session) cds.context[SESSION_KEY] = session
    },

    wrapToolCall: async (request, handler) => {
      const session = cds.context?.[SESSION_KEY]
      if (!session) return handler(request)

      const toolName = request.toolCall?.name
      const toolArgs = request.toolCall?.args ?? {}
      const resolvedArgs = resolveArgs(toolArgs, session)
      const resolvedRequest = resolvedArgs !== toolArgs
        ? { ...request, toolCall: { ...request.toolCall, args: resolvedArgs } }
        : request

      const toolMessage = await handler(resolvedRequest)

      let outMessage = toolMessage
      if (toolMessage?.content) {
        const content = await scrubToolCallResult({
          carrier: toolMessage,
          content: toolMessage.content,
          toolName,
          cql: toolArgs.cql ?? toolArgs.sql,
        })
        if (content !== toolMessage.content) {
          const { ToolMessage } = await import("@langchain/core/messages")
          outMessage = new ToolMessage({ ...toolMessage, content })
        }
      }

      await session.flush()
      return outMessage
    },

    wrapModelCall: async (request, handler) => {
      const session = cds.context?.[SESSION_KEY]
      if (!session) return handler(request)

      if (!cds.env.agents?.masking?.resolveInTraces) {
        const scrubbed = request.messages?.map(msg => {
          if (typeof msg.content !== "string") return msg
          const content = session.scrubText(msg.content)
          if (content === msg.content) return msg
          // Rebuild via the message's class so its type/metadata survive.
          const Ctor = msg.constructor
          return new Ctor({ ...msg, content })
        })
        if (scrubbed) return handler({ ...request, messages: scrubbed })
      }

      return handler(request)
    },

    afterAgent: async (state) => {
      const session = cds.context?.[SESSION_KEY]
      if (!session) return state

      const messages = state.messages
      if (!messages?.length) return state
      const last = messages[messages.length - 1]
      if (last?.type !== "ai") return state

      const content = typeof last.content === "string" ? session.resolveText(last.content) : last.content
      if (content === last.content) return state

      const { AIMessage } = await import("@langchain/core/messages")
      return { ...state, messages: [...messages.slice(0, -1), new AIMessage({ ...last, content })] }
    },
  })
}
