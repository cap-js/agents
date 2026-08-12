import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { AIMessage } from "@langchain/core/messages"
import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import { timeout, retry } from "@sap-cloud-sdk/resilience"
import { toSdkFilterFormat } from "../../../lib/models/aicore.js"
import { audit } from "../../utils/utils.js"
import { INSTRUMENTED } from "../../telemetry/tracing.js"

const LOG = cds.log("agent")

/**
 * Extract HTTP status and response data from a wrapped AI SDK error wrapped
 * within langchain middleware wraps.
 */
function extractErrorDetails(err) {
  let current = err
  while (current) {
    // Direct properties (e.g. MiddlewareError that has them)
    if (current.rootCause?.status != null) {
      return { status: current.rootCause.status, data: current.rootCause.response?.data }
    }
    // Check if current error itself is an axios-like response
    if (current.status != null && current.response?.data) {
      return { status: current.status, data: current.response.data }
    }
    current = current.cause
  }
  return { status: undefined, data: undefined }
}

/**
 * Content filter middleware - workaround for aicore limitations on input filtering.
 * Checks latest user input / tool result against input filters via a
 * cheap model call (max_tokens:1) before the real model processes full context.
 */
export async function contentFilterMiddleware(model) {
  const { contentFilter } = model?.options ?? {}
  if (!contentFilter?.input) return

  const inputFiltering = toSdkFilterFormat({ input: contentFilter.input })

  const inputFilterModel = new OrchestrationClient(
    {
      promptTemplating: { model: { name: "gpt-4o-mini", params: { max_tokens: 1 } } },
      filtering: inputFiltering,
    },
    {
      disableStreaming: true,
      customRequestConfig: {
        middleware: [timeout(10_000), retry(2)],
      },
    },
    model?.deploymentConfig,
    model?.destination,
  )
  // Opt this internal probe out of generic LangChain tracing: it runs before the
  // real model (BeforeModelNode) and would otherwise emit a "chat OrchestrationClient"
  // span that shadows the real model's chat span in same-trace span lookups.
  inputFilterModel[INSTRUMENTED] = true

  return createMiddleware({
    name: "ContentFilterMiddleware",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async (state) => {
        const messages = state.messages || []

        // Sanitize poisoned tool messages that triggered a prior content filter block.
        // Detected by: tool message immediately followed by AI "malicious result" recovery.
        for (let i = 0; i < messages.length - 1; i++) {
          const type = messages[i]._getType?.() || messages[i].type
          const nextType = messages[i + 1]?._getType?.() || messages[i + 1]?.type
          if (type === "tool" && nextType === "ai") {
            const nextContent = messages[i + 1]?.content || ""
            if (/malicious result/i.test(nextContent) && messages[i].content) {
              messages[i].content = ""
            }
          }
        }

        // Extract messages after the last AI message (new input for this model call)
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
            // Stop at first AI/system message — anything before is already processed
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
          const { status, data } = extractErrorDetails(err)
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
                messages: [new AIMessage(cds.i18n.messages.at("CONTENT_FILTER_BLOCKED"))],
              }
            }
          } else {
            // Fail closed: unrecognized errors (timeout, 5xx, network) block the message
            LOG.warn("Content filter unavailable — blocking input", {
              error: err.message,
              status,
            })
            if (hasHumanMessage) {
              return {
                jumpTo: "end",
                messages: [new AIMessage(cds.i18n.messages.at("CONTENT_FILTER_UNAVAILABLE"))],
              }
            }
          }
        }
      },
    },
    wrapModelCall: async (request, handler) => {
      try {
        return await handler(request)
      } catch (err) {
        const { status, data } = extractErrorDetails(err)
        const isFilterBlock =
          /Filtering Module/i.test(data?.error?.location || "") && status === 400

        if (isFilterBlock) {
          const lastMsg = request.state?.messages?.at(-1)
          const isTool = lastMsg?._getType?.() === "tool" || lastMsg?.type === "tool"
          const reason = data?.error?.message || "Content filter blocked"

          LOG.warn("Content filter blocked model response", {
            reason,
            source: isTool ? "tool" : "model",
          })
          audit("ContentFilterBlocked", {
            data: {
              service: cds.context?.["agent.service"],
              user: cds.context?.user?.id,
              taskId: cds.context?.["agent.task.id"],
              reason,
              source: isTool ? "tool" : "model",
            },
          })

          // Return graceful AI message so the agent can recover
          const message = isTool
            ? cds.i18n.messages.at("CONTENT_FILTER_TOOL_BLOCKED")
            : reason.split("-").at(-1)?.trim() || cds.i18n.messages.at("CONTENT_FILTER_BLOCKED")

          return new AIMessage(message)
        }
        throw err
      }
    },
  })
}
