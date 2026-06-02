import cds from "@sap/cds"
import { AIMessage } from "@langchain/core/messages"

const LOG = cds.log("a2a")

/**
 * Walk up to 5 levels of the error cause chain looking for an SAP AI Core
 * Filtering Module response. Returns:
 *   { kind: "blocked" }   — 400 with location "Filtering Module" (prompt blocked)
 *   { kind: "upstream" }  — 503 with `AI-External-Failure: true` (Azure rejected payload)
 *   { kind: null }        — not a filter error
 */
export function classifyFilterError(err) {
  let cur = err
  for (let i = 0; cur && i < 5; i++) {
    const status = cur.status ?? cur.rootCause?.status ?? cur.cause?.status
    const data = cur.response?.data ?? cur.rootCause?.response?.data ?? cur.cause?.response?.data
    const headers =
      cur.response?.headers ?? cur.rootCause?.response?.headers ?? cur.cause?.response?.headers
    const isFilterModule = /Filtering Module/i.test(data?.error?.location || "")

    if (isFilterModule && status === 400) {
      return { kind: "blocked", message: data.error.message }
    }
    if (isFilterModule && status === 503 && headers?.["ai-external-failure"] === "true") {
      return { kind: "upstream", message: data?.error?.message || "Content filter unavailable" }
    }
    cur = cur.cause ?? cur.rootCause
  }
  return { kind: null }
}

/**
 * LangChain agent middleware that gracefully recovers from SAP AI Core
 * content filter errors. Use with `createDeepAgent({ middleware: [...] })`.
 *
 * Recovery behavior:
 *   - 400 (input blocked by filter, e.g. prompt injection) → returns an
 *     AIMessage acknowledging the block instead of crashing the task.
 *   - 503 with `AI-External-Failure: true` (Azure Content Safety rejected the
 *     payload, typically because it exceeded the prompt_shield size limit) →
 *     returns an AIMessage explaining the issue.
 *   - Any other error → re-thrown unchanged.
 */
export async function contentFilterRecoveryMiddleware() {
  // Lazy import to avoid hard dependency
  const { createMiddleware } = await import("langchain")

  return createMiddleware({
    name: "a2aContentFilterRecovery",
    wrapModelCall: async (request, handler) => {
      try {
        return await handler(request)
      } catch (err) {
        const { kind, message } = classifyFilterError(err)

        if (kind === "blocked") {
          LOG.warn("Content filter blocked input — recovering", { reason: message })
          return new AIMessage(
            "Your input was blocked by the content safety filter. Please rephrase your request.",
          )
        }
        if (kind === "upstream") {
          LOG.warn("Content filter service unavailable — recovering", { reason: message })
          return new AIMessage(
            "The content safety service rejected this request (the payload may be too large). " +
              "Please try a shorter request or contact the administrator.",
          )
        }
        throw err
      }
    },
  })
}
