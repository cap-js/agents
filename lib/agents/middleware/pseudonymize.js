import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { PseudoSession } from "../../pseudonymize/store.js"
import {
  hasPersonalDataAnnotations,
  queryEntityElements,
  actionReturnElements,
  pseudonymizeData,
  resolveArgs,
} from "../../pseudonymize/helpers.js"

const LOG = cds.log("agents")

function threadIdFromContext() {
  return `${cds.context?.["agent.service"]}:${cds.context?.["agent.context.id"]}`
}

export function pseudonymizeMiddleware(srv) {
  if (cds.env.agents?.masking === false) return null

  return createMiddleware({
    name: "pseudonymize",

    // Establish the session once per agent run: gate on annotations, load/create
    // the PseudoSession, and stash it on cds.context. The wrap hooks below only
    // read cds.context["_pseudoSession"] — no per-call lookup or stashing.
    beforeAgent: async () => {
      const model = cds.context?.model ?? srv.model
      if (!hasPersonalDataAnnotations(model, srv.name)) return
      const session = await PseudoSession.loadOrCreate(threadIdFromContext())
      if (session) cds.context["_pseudoSession"] = session
    },

    wrapToolCall: async (request, handler) => {
      const session = cds.context?.["_pseudoSession"]
      if (!session) return handler(request)

      const model = cds.context?.model ?? srv.model
      const srvMaskingOff = model.definitions?.[srv.name]?.["@agent.masking"] === false

      const toolName = request.toolCall?.name
      const toolArgs = request.toolCall?.args ?? {}
      const resolvedArgs = resolveArgs(toolArgs, session)
      const resolvedRequest = resolvedArgs !== toolArgs
        ? { ...request, toolCall: { ...request.toolCall, args: resolvedArgs } }
        : request

      const toolMessage = await handler(resolvedRequest)

      let outMessage = toolMessage
      if (!srvMaskingOff && toolMessage?.content) {
        try {
          const { decode, encode } = await import("@toon-format/toon")
          const decoded = decode(typeof toolMessage.content === "string" ? toolMessage.content : "")
          const annotatedFields = toolName === "query"
            ? queryEntityElements(model, srv, toolArgs.cql, true)
            : actionReturnElements(model, srv, toolName, true)

          if (decoded?.data && annotatedFields.size) {
            pseudonymizeData(decoded.data, annotatedFields, session)
            const { ToolMessage } = await import("@langchain/core/messages")
            outMessage = new ToolMessage({ ...toolMessage, content: encode(decoded) })
          }
        } catch (err) {
          LOG.warn("pseudonymize: failed to process tool result", { tool: toolName, error: err.message })
        }
      }

      await session.flush()
      return outMessage
    },

    wrapModelCall: async (request, handler) => {
      const session = cds.context?.["_pseudoSession"]
      if (!session) return handler(request)

      if (!cds.env.agents?.masking?.resolveInTraces) {
        const scrubbed = request.messages?.map(msg => {
          if (typeof msg.content !== "string") return msg
          const content = session.scrubText(msg.content)
          if (content === msg.content) return msg
          // Rebuild via the message's own class so its type (human/ai/tool/…)
          // and metadata survive; a plain {...msg} spread would drop the class.
          const Ctor = msg.constructor
          return new Ctor({ ...msg, content })
        })
        if (scrubbed) return handler({ ...request, messages: scrubbed })
      }

      return handler(request)
    },

    afterAgent: async (state) => {
      const session = cds.context?.["_pseudoSession"]
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
