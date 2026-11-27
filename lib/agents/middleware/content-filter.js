import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { audit } from "../../utils/utils.js"

const LOG = cds.log("agents")

/** Scope filtering to new input and persist safe conversation history when it is blocked. */
export function contentFilterMiddleware(model) {
  if (!model?.options?.contentFilter) return

  return createMiddleware({
    name: "ContentFilterMiddleware",
    wrapModelCall: async (request, handler) => {
      const messages = request.systemMessage?.text
        ? [request.systemMessage, ...request.messages]
        : request.messages
      const { index, target } = inputFilterBoundary(messages)
      try {
        return await handler({
          ...request,
          modelSettings: { ...request.modelSettings, inputFilterTarget: target },
        })
      } catch (err) {
        const { status, data } = extractErrorDetails(err)
        if (status !== 400 || !/Filtering Module/i.test(data?.error?.location || "")) throw err

        const isOutput = /Output Filter/i.test(data.error.location)
        const isTool = ToolMessage.isInstance(messages.at(-1))
        const source = isOutput ? "model" : isTool ? "tool" : "user"
        LOG.warn("Content filter blocked content", { reason: data.error.message, source })
        audit("ContentFilterBlocked", {
          data: {
            service: cds.context?.["agent.service"],
            user: cds.context?.user?.id,
            taskId: cds.context?.["agent.task.id"],
            reason: data.error.message,
            source,
          },
        })

        // A filter rejects the entire selected batch, without identifying a single
        // offending message. Replace all of it, preserving tool-call/result pairing.
        const rejected = isOutput ? [] : messages.slice(index + 1)
        const ids = new Set(
          rejected
            .filter((m) => HumanMessage.isInstance(m) || ToolMessage.isInstance(m))
            .map((m) => m.id)
            .filter(Boolean),
        )
        const redacted = (request.state.messages || [])
          .filter((m) => ids.has(m.id))
          .map((m) => {
            const fields = { id: m.id, content: "[Content removed by the content safety filter.]" }
            return ToolMessage.isInstance(m)
              ? new ToolMessage({
                  ...fields,
                  content:
                    "This tool result was withheld by the content safety filter. Try a different query or source.",
                  tool_call_id: m.tool_call_id,
                  name: m.name,
                  status: "error",
                })
              : new HumanMessage(fields)
          })
        if (source === "tool") return new Command({ update: { messages: redacted } })

        const response = new AIMessage(cds.i18n.messages.at("CONTENT_FILTER_BLOCKED"))

        return new Command({ update: { messages: [...redacted, response] } })
      }
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: (state) => {
        // A rejected tool batch leaves error results instead of an assistant reply.
        // Continue only after those replacements have been checkpointed.
        const last = state.messages.at(-1)
        if (ToolMessage.isInstance(last) && last.status === "error") return { jumpTo: "model" }
      },
    },
  })
}

function inputFilterBoundary(messages) {
  const roles = messages.map((m) => m._getType?.() || m.type)
  const assistant = roles.lastIndexOf("ai")
  if (assistant >= 0) return { index: assistant, target: "assistant" }
  const system = roles.lastIndexOf("system")
  return { index: system, target: system >= 0 ? "system" : null }
}

/** Find the AI Core HTTP response through SDK/LangChain error wrappers. */
function extractErrorDetails(err) {
  const seen = new Set()
  while (err && !seen.has(err)) {
    seen.add(err)
    const status = err.status ?? err.statusCode ?? err.response?.status
    const data = err.response?.data ?? err.data
    if (status != null && data) return { status, data }
    err = err.rootCause ?? err.cause
  }
  return {}
}
