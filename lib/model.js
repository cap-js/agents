const cds = require("@sap/cds")
const { circuitBreaker, timeout } = require("@sap-cloud-sdk/resilience")
const metrics = require("./telemetry/metrics")
const { INSTRUMENTED } = require("./telemetry/tracing")

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
 * @param {string} [options.name] - Model name (default: cds.env.a2a.llm)
 * @param {object} [options.params] - Model params (default: { max_tokens: 4096, temperature: 0 })
 * @returns {OrchestrationClient} A LangChain-compatible chat model
 */
function createDeepAgentModel(options = {}) {
  const { OrchestrationClient } = require("@sap-ai-sdk/langchain")

  const name = options.name || cds.env.a2a?.llm
  const params = options.params || { max_tokens: 4096, temperature: 0 }

  LOG.debug("Initializing deep agent model", { model: name })

  const flattenFn = flattenMessages
  class FlatteningOrchestrationClient extends OrchestrationClient {
    async _generate(messages, opts, runManager) {
      const tracer = metrics.getTracer()
      const node = opts?.runName || "unknown"
      const mAttrs = {
        "sap.tenantId": cds.context?.tenant || "anonymous",
        "a2a.service": cds.context?.["a2a.service"],
        model: name,
        node,
      }

      const invoke = async (span) => {
        if (span) {
          span.setAttribute("gen_ai.operation.name", "chat")
          span.setAttribute("gen_ai.provider.name", "sap-ai-core")
          span.setAttribute("gen_ai.request.model", name)
          if (params?.temperature != null)
            span.setAttribute("gen_ai.request.temperature", params.temperature)
          if (params?.max_tokens != null)
            span.setAttribute("gen_ai.request.max_tokens", params.max_tokens)
          if (cds.context?.["a2a.context.id"])
            span.setAttribute("gen_ai.conversation.id", cds.context["a2a.context.id"])
          span.setAttribute("a2a.span.kind", "chat")
          span.setAttribute("a2a.llm.node", node)
          if (LOG._debug) {
            const content = JSON.stringify(messages.map((m) => m.content))
            span.setAttribute("gen_ai.input.messages", content)
            span.setAttribute("a2a.entity.input", content)
          }
        }

        let result
        try {
          const llmTimeout = cds.env.a2a?.pool?.maxLLMCallTimeoutMs || 30000
          opts = {
            ...opts,
            customRequestConfig: {
              ...opts?.customRequestConfig,
              middleware: [timeout(llmTimeout), circuitBreaker()],
            },
          }
          result = await super._generate(flattenFn(messages), opts, runManager)
        } catch (err) {
          metrics.llmInvocations.add(1, { ...mAttrs, outcome: "error" })
          if (span) {
            span.setAttribute("error.type", err.constructor?.name || "Error")
            span.setStatus({ code: 2, message: err.message })
          }
          throw err
        }

        metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
        const usage = result.generations?.[0]?.message?.usage_metadata
        if (usage?.input_tokens) {
          metrics.llmInputTokens.add(usage.input_tokens, mAttrs)
          if (span) span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens)
        }
        if (usage?.output_tokens) {
          metrics.llmOutputTokens.add(usage.output_tokens, mAttrs)
          if (span) span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
        }
        if (span) {
          const msg = result.generations?.[0]?.message
          const responseId = msg?.response_metadata?.id || msg?.id
          if (responseId) span.setAttribute("gen_ai.response.id", responseId)
          if (msg?.tool_calls?.length > 0) {
            span.setAttribute(
              "gen_ai.response.tool_calls",
              JSON.stringify(msg.tool_calls.map((tc) => ({ name: tc.name, args: tc.args }))),
            )
          }
        }
        if (span && LOG._debug) {
          const output = JSON.stringify(result.generations?.[0]?.message?.content)
          span.setAttribute("gen_ai.output.messages", output)
          span.setAttribute("a2a.entity.output", output)
        }

        return result
      }

      if (tracer) {
        return tracer.startActiveSpan(
          `chat ${name}`,
          { kind: 3 /* SpanKind.CLIENT */ },
          async (span) => {
            try {
              return await invoke(span)
            } finally {
              span.end()
            }
          },
        )
      }
      return invoke(null)
    }
  }
  FlatteningOrchestrationClient[INSTRUMENTED] = true

  return new FlatteningOrchestrationClient({
    promptTemplating: { model: { name, params } },
  })
}

module.exports = { createDeepAgentModel, flattenMessages }
