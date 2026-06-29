import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { AIMessage } from "@langchain/core/messages"
import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import { buildContentFilter, toSdkFilterFormat } from "../../../../srv/handlers/content-filter.js"
import { audit } from "../../../utils/utils.js"

const LOG = cds.log("agent")

/**
 * Content filter middleware for deep agents.
 * Checks latest user input / tool result against input filters via a
 * cheap model call (max_tokens:1) before the real model processes full context.
 */
export async function contentFilterMiddleware() {
  const filterConfig = buildContentFilter()
  if (!filterConfig?.input) {
    return createMiddleware({ name: "ContentFilterMiddleware" })
  }

  const inputFiltering = toSdkFilterFormat({ input: filterConfig.input })

  const inputFilterModel = new OrchestrationClient({
    promptTemplating: { model: { name: "gpt-4o-mini", params: { max_tokens: 1 } } },
    filtering: inputFiltering,
  })

  return createMiddleware({
    name: "ContentFilterMiddleware",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async (state) => {
        const messages = state.messages || []

        // Extract last consecutive human/tool messages (new input to check)
        const toFilter = []
        let hasHumanMessage = false
        for (let i = messages.length - 1; i >= 0; i--) {
          const type = messages[i]._getType?.() || messages[i].type
          if (type === "human") {
            toFilter.unshift(messages[i])
            hasHumanMessage = true
          } else if (type === "tool") {
            toFilter.unshift(messages[i])
          } else {
            break
          }
        }

        if (toFilter.length === 0) return

        // Convert tool messages to human messages for the filter model
        // (OrchestrationClient requires human messages to trigger input filter)
        const { HumanMessage } = await import("@langchain/core/messages")
        const filterMessages = toFilter.map((m) => {
          const type = m._getType?.() || m.type
          if (type === "tool") {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            return new HumanMessage(content)
          }
          return m
        })

        try {
          await inputFilterModel.invoke(filterMessages)
        } catch (err) {
          const status = err.rootCause?.status ?? err.cause?.status
          const data = err.rootCause?.response?.data ?? err.cause?.response?.data
          const isFilterBlock =
            /Filtering Module/i.test(data?.error?.location || "") && status === 400

          if (isFilterBlock) {
            LOG.warn("Content filter blocked input", { reason: data?.error?.message })
            audit("ContentFilterBlocked", {
              data: {
                service: cds.context?.["agent.service"],
                user: cds.context?.user?.id,
                taskId: cds.context?.["agent.task.id"],
                reason: data?.error?.message,
                source: hasHumanMessage ? "user" : "tool",
              },
            })
            // Only terminate for human messages; tool results continue (let model handle)
            if (hasHumanMessage) {
              return {
                jumpTo: "end",
                messages: [
                  new AIMessage(
                    "Your input was blocked by the content safety filter. Please rephrase.",
                  ),
                ],
              }
            }
          }
          LOG.debug("Content filter check skipped", { error: err.message })
        }
      },
    },
  })
}
