import cds from "@sap/cds"
import { HumanMessage } from "@langchain/core/messages"
import { short } from "../utils/utils.js"

const LOG = cds.log("agent")

const DEFAULT_TIMEOUT = 10_000

/**
 * Summarize partial work from a graph execution that was interrupted
 * (timeout, quota exceeded, or other forced stop).
 *
 * Reads partial conversation from the checkpoint and asks the LLM to
 * produce a concise progress summary. Falls back to a generic message
 * on any failure (no checkpointer, empty state, LLM unreachable).
 *
 * @param {object} options
 * @param {string} options.taskId
 * @param {string} options.contextId
 * @param {string} options.serviceName
 * @param {string} options.reason - Why execution was interrupted (e.g. "timed out", "quota exceeded")
 * @param {object} [options.checkpointer] - LangGraph checkpointer instance
 * @param {Function} options.getModel - Async function returning a LangChain chat model
 * @param {number} [options.timeout] - Max ms to spend on summarization (default 10s)
 * @returns {Promise<string>} Summary message or fallback
 */
export async function summarizePartialWork({
  taskId,
  contextId,
  serviceName,
  reason,
  checkpointer,
  getModel,
  timeout = DEFAULT_TIMEOUT,
}) {
  const fallback = `The task was stopped (${reason}). Some work may have been done — please check the results or retry with a simpler request.`

  try {
    if (!getModel) return fallback
    if (!checkpointer?.getTuple) return fallback

    const cp = await checkpointer.getTuple({
      configurable: { thread_id: `${serviceName}:${contextId}` },
    })
    const messages = cp?.checkpoint?.channel_values?.messages
    if (!messages?.length) return fallback

    // Extract last few messages as context for summarization (cap at 10)
    const recentMessages = messages.slice(-10)
    const conversationSnippet = recentMessages
      .map((m) => {
        const role = m._getType?.() || m.type || "unknown"
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        return `[${role}]: ${content?.slice(0, 500)}`
      })
      .join("\n")
    const summaryPrompt = `The following agent task was interrupted (${reason}). Based on the conversation so far, provide a brief summary of what was accomplished and what remains. Be concise.

Conversation:
${conversationSnippet}`

    let summaryTimer
    try {
      const response = await Promise.race([
        (async () => {
          const model = await getModel()
          return model.invoke([new HumanMessage(summaryPrompt)])
        })(),
        new Promise((_, reject) => {
          summaryTimer = setTimeout(() => reject(new Error("Summary LLM call timed out")), timeout)
        }),
      ])

      const summary =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content)

      LOG.info("partial work summary generated", {
        task: short(taskId),
        service: serviceName,
        reason,
      })
      return `Task stopped (${reason}). Progress summary: ${summary}`
    } finally {
      clearTimeout(summaryTimer)
    }
  } catch (err) {
    LOG.debug("partial work summary failed, using fallback", {
      task: short(taskId),
      error: err.message,
    })
    return fallback
  }
}
