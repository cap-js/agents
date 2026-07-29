import { createMiddleware } from "langchain"
import { AIMessage, ToolMessage } from "@langchain/core/messages"

/**
 * Middleware that patches dangling tool calls before each model call.
 *
 * When a task is interrupted mid-flight (quota exceeded, timeout, or cancellation),
 * the checkpoint history may end with an AIMessage containing tool_calls that were
 * never executed — no matching ToolMessage was written because the tools node never
 * ran. On the next turn, sending this history to the LLM causes a 400 error (e.g.
 * AI Core, Anthropic) because providers enforce strict tool_call / tool_result parity.
 *
 */
export function patchToolCallsMiddleware() {
  return createMiddleware({
    name: "patchToolCallsMiddleware",
    wrapModelCall: async (request, handler) => {
      const messages = request.messages
      if (!messages?.length) return handler(request)

      const patched = []
      let needsPatch = false

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        patched.push(msg)

        if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const hasResponse = messages
              .slice(i + 1)
              .some((m) => ToolMessage.isInstance(m) && m.tool_call_id === tc.id)

            if (!hasResponse) {
              needsPatch = true
              patched.push(
                new ToolMessage({
                  content: `Tool call ${tc.name} was cancelled before it could complete.`,
                  name: tc.name,
                  tool_call_id: tc.id,
                }),
              )
            }
          }
        }
      }

      return handler(needsPatch ? { ...request, messages: patched } : request)
    },
  })
}
