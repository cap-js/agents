const cds = require("@sap/cds")

const LOG = cds.log("a2a")

/**
 * deepagents' built-in tools (read_file, ls, grep, etc.) return content as
 * [{type: "text", text: "..."}] arrays (MCP-style content blocks).
 * SAP AI Core's orchestration API expects content as a plain string.
 * Without flattening, AI Core rejects the request with HTTP 400.
 */
function flattenMessages(messages) {
  const { SystemMessage, ToolMessage, HumanMessage } = require("@langchain/core/messages")
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m
    // AIMessages may have tool_calls alongside content — leave those untouched
    if (m.tool_calls?.length > 0) return m
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n\n")
    if (ToolMessage.isInstance?.(m) || m._getType?.() === "tool") {
      return new ToolMessage({ content: text, tool_call_id: m.tool_call_id, name: m.name })
    }
    if (SystemMessage.isInstance?.(m) || m._getType?.() === "system") {
      return new SystemMessage(text)
    }
    if (HumanMessage.isInstance?.(m) || m._getType?.() === "human") {
      return new HumanMessage(text)
    }
    // Fallback: flatten content for any other message type
    return { ...m, content: text }
  })
}

/**
 * Creates an LLM model compatible with deepagents (createDeepAgent).
 *
 * Wraps SAP AI Core's OrchestrationClient to handle array-content messages
 *
 * @param {string} [options.name] - Model name (default: cds.env.a2a.llm || "anthropic--claude-4.5-sonnet")
 * @param {object} [options.params] - Model params (default: { max_tokens: 4096, temperature: 0 })
 * @returns {OrchestrationClient} A LangChain-compatible chat model
 */
function createDeepAgentModel(options = {}) {
  const { OrchestrationClient } = require("@sap-ai-sdk/langchain")

  const name =
    options.name || cds.env.a2a?.llm || process.env.AICORE_MODEL || "anthropic--claude-4.5-sonnet"
  const params = options.params || { max_tokens: 4096, temperature: 0 }

  LOG.info("Initializing deep agent model", { model: name })

  const flattenFn = flattenMessages
  class FlatteningOrchestrationClient extends OrchestrationClient {
    async _generate(messages, opts, runManager) {
      return super._generate(flattenFn(messages), opts, runManager)
    }
  }

  return new FlatteningOrchestrationClient({
    promptTemplating: { model: { name, params } },
  })
}

module.exports = { createDeepAgentModel, flattenMessages }
