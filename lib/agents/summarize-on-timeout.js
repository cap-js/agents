import cds from "@sap/cds"
import { HumanMessage } from "@langchain/core/messages"
import { short } from "../utils/utils.js"
import { publishStatus } from "./middleware/status-update.js"

const LOG = cds.log("agents")

const DEFAULT_TIMEOUT = 20_000

/**
 * Summarize partial work from a graph execution that was interrupted
 * (timeout, quota exceeded, or other forced stop).
 *
 * Reads partial conversation from the checkpoint and asks the LLM to
 * produce a concise progress summary. Falls back to a generic message
 * on any failure (no checkpointer, empty state, LLM unreachable).
 *
 * @param {object} options
 * @param {string} options.contextId
 * @param {string} options.serviceName
 * @param {string} options.reason - Why execution was interrupted (e.g. "timed out", "quota exceeded")
 * @param {object} [options.checkpointer] - LangGraph checkpointer instance
 * @param {Function} options.getModel - Async function returning a LangChain chat model
 * @param {number} [options.timeout] - Max ms to spend on summarization (default 20s)
 * @param {boolean} [options.approval] - Generate a continuation approval prompt
 * @returns {Promise<string>} Summary message or fallback
 */
export async function summarizePartialWork({
  contextId,
  serviceName,
  reason,
  checkpointer,
  getModel,
  timeout = DEFAULT_TIMEOUT,
  approval = false,
}) {
  publishStatus(cds.i18n.messages.at(`agent_status_summarizing_progress`))
  const fallback = cds.i18n.messages.at(
    approval ? "AGENT_SUMMARY_TIMEOUT_FALLBACK" : "AGENT_SUMMARY_FALLBACK",
    [reason],
  )

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
    let summaryPrompt = approval
      ? `Agent task was not completed within its time limit. Write short, precise progress summary so user can decide whether to continue. State completed work and immediate next work. Do not claim work not shown. Start with: Agent did not finish within time! End with: Continue running or stop? No other questions to the user allowed!`
      : `Agent task was interrupted. Reason: ${reason}. Based on conversation history, provide brief summary of completed work and remaining work. Be concise.`
    summaryPrompt += `\n\n Conversation Snippet: \n\n ${conversationSnippet.trim()}`

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
        typeof response.content === "string" ? response.content : response.content?.[0]?.text
      if (!summary) throw new Error("Summary LLM returned no text")

      LOG.info("partial work summary generated", {
        conversation: short(contextId),
        service: serviceName,
        reason,
      })
      return summary
    } finally {
      clearTimeout(summaryTimer)
    }
  } catch (err) {
    LOG.debug("partial work summary failed, using fallback", {
      conversation: short(contextId),
      service: serviceName,
      error: err.message,
    })
    return fallback
  }
}
