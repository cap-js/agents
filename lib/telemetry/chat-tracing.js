import cds from "@sap/cds"
import * as metrics from "./metrics.js"
import { mlflowAttrs, setSpanAttrs } from "./mlflow.js"
import { audit } from "../utils/utils.js"

const LOG = cds.log("agents")

const PATCHED = Symbol.for("@cap-js/agents:patched")
const SPAN_KIND_CLIENT = 3

// ─── Public API ──────────────────────────────────────────────────────────────

export async function patchChatModel() {
  try {
    const mod = await import("@langchain/core/language_models/chat_models")
    if (mod.BaseChatModel?.prototype) _patchChatModelProto(mod.BaseChatModel.prototype)

    // Also patch CJS prototype (different from ESM in dual-package modules)
    try {
      const { createRequire } = await import("node:module")
      const req = createRequire(import.meta.url)
      const cjs = req("@langchain/core/language_models/chat_models")
      if (cjs.BaseChatModel?.prototype) _patchChatModelProto(cjs.BaseChatModel.prototype)
    } catch {
      /* CJS not available */
    }
  } catch (err) {
    LOG.error("Failed to patch BaseChatModel for tracing", { error: err.message })
  }
}

// ─── Prototype patch ─────────────────────────────────────────────────────────

export function _patchChatModelProto(proto) {
  if (proto[PATCHED]) return
  const original = proto.invoke
  if (typeof original !== "function") {
    LOG.warn("BaseChatModel.invoke not found — tracing patch skipped")
    return
  }

  proto.invoke = async function (input, opts) {
    // Skip instances explicitly opted out (e.g. content-filter probe model)
    const INSTRUMENTED = Symbol.for("@cap-js/agents:instrumented")
    if (this[INSTRUMENTED]) return original.call(this, input, opts)

    const tracer = metrics.getTracer()
    if (!tracer) return original.call(this, input, opts)

    const model = this.options?.model || this.model || this.constructor.name
    const provider = _detectProvider(this)
    const node = opts?.runName || "agent"
    const messages = Array.isArray(input) ? input : undefined
    const cacheControl = _detectCacheControl(messages)
    const streaming = this.streaming || this.orchestrationConfig?.streaming || false
    const mAttrs = _metricAttrs(model, node)

    const invoke = async (span) => {
      if (span) {
        setLLMSpanStartAttrs(span, {
          model,
          provider,
          params: this.options?.params,
          streaming,
          cacheControl,
          node,
          messages,
        })
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, input, opts)
        const duration = Date.now() - t0
        const ir = result.additional_kwargs?.intermediate_results
        if (span && ir) {
          if (ir.input_filtering) span.setAttribute("gen_ai.orchestration.input_filtering", true)
          if (ir.output_filtering) span.setAttribute("gen_ai.orchestration.output_filtering", true)
          if (ir.input_masking) span.setAttribute("gen_ai.orchestration.input_masking", true)
          const appliedFilterAmount = (filtering) => {
            let res = []
            for (const entry of filtering?.data?.choices ?? []) {
              Object.keys(entry).forEach((e) => {
                if (e !== "index") {
                  res = res.concat(Object.keys(entry[e]).map((filter) => `${e}_${filter}`))
                }
              })
            }
            return res
          }
          let ic = appliedFilterAmount(ir.input_filtering)
          let oc = appliedFilterAmount(ir.output_filtering)
          if (ic.length)
            span.setAttribute("gen_ai.orchestration.input_filter_services", JSON.stringify(ic))
          if (oc.length)
            span.setAttribute("gen_ai.orchestration.output_filter_services", JSON.stringify(oc))
        }

        /** @type {import('@langchain/core/messages').UsageMetadata} */
        const usage = result.usage_metadata
        const finishReason =
          result.response_metadata?.finish_reason ||
          result.response_metadata?.stop_reason ||
          (result.tool_calls?.length > 0 ? "tool_use" : "stop")

        _handleSuccess(span, {
          model,
          provider,
          mAttrs,
          opts,
          params: this.options?.params,
          node,
          tokenUsage: convertUsageData(usage),
          outputContent: result.content ? extractText(result.content) : undefined,
          response: {
            finishReason,
            model: result.response_metadata?.model_name || result.response_metadata?.model || model,
            id: result.response_metadata?.id || result.id,
            toolCalls: result.tool_calls?.map((tc) => ({ name: tc.name, args: tc.args })),
          },
          duration,
        })
        return result
      } catch (err) {
        _handleError(span, { err, mAttrs, model, node, messages })
        throw err
      } finally {
        if (span) span.end()
      }
    }

    return tracer.startActiveSpan(`chat ${model}`, { kind: SPAN_KIND_CLIENT }, (span) =>
      invoke(span),
    )
  }
  proto[PATCHED] = true
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Detect LLM provider from model instance properties. */
function _detectProvider(instance) {
  if (instance.orchestrationConfig) return "sap-ai-core"
  return "langchain"
}

function _metricAttrs(model, node) {
  return {
    "sap.tenantId": cds.context?.tenant || "anonymous",
    "agent.service": cds.context?.["agent.service"],
    model,
    node,
  }
}

/** Detect cache_control presence in messages (set by injectCacheControl in aicore). */
function _detectCacheControl(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((m) => {
    if (!Array.isArray(m.content)) return false
    return m.content.some((b) => b.cache_control)
  })
}

/** Handle successful LLM call: metrics, span end attrs, truncation warning, audit. */
function _handleSuccess(
  span,
  { model, provider, mAttrs, opts, params, node, tokenUsage, outputContent, response, duration },
) {
  metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
  if (tokenUsage?.input_tokens) metrics.llmInputTokens.add(tokenUsage.input_tokens, mAttrs)
  if (tokenUsage?.output_tokens) metrics.llmOutputTokens.add(tokenUsage.output_tokens, mAttrs)

  if (span) {
    setLLMSpanEndAttrs(span, { model, provider, tokenUsage, outputContent, response })
    span.setStatus({ code: 1 })
  }

  if (response?.finishReason === "length" || response?.finishReason === "max_tokens") {
    LOG.warn("LLM response truncated: output_tokens reached max_tokens limit", {
      model,
      node,
      max_tokens: params?.max_tokens,
      output_tokens: tokenUsage?.output_tokens,
    })
  }

  const taskId = opts?.configurable?._taskId || cds.context?.["agent.task.id"]
  if (taskId) {
    audit("AgentDecision", {
      data: {
        taskId,
        contextId:
          opts?.configurable?.thread_id?.split(":")[1] || cds.context?.["agent.context.id"],
        service: opts?.configurable?._service || cds.context?.["agent.service"],
        model,
        iteration: opts?.configurable?._iteration ?? cds.context?.["agent.iteration"],
        toolCalls: response?.toolCalls,
        tokenUsage,
        duration,
      },
    })
  }
}

/** Handle LLM error: content-filter warnings, metrics, span error attrs. */
function _handleError(span, { err, mAttrs, model, node, messages }) {
  const status = err.rootCause?.status
  const data = err.rootCause?.response?.data
  const headers = err.rootCause?.response?.headers
  const isFilterModule = /Filtering Module/i.test(data?.error?.location || "")
  const isExternalFailure = headers?.["ai-external-failure"] === "true"

  if (isFilterModule && status === 503 && isExternalFailure) {
    LOG.warn(
      "Content filter service rejected the request (likely payload too large for prompt_shield). " +
        "Disable content filtering via the buildContentFilter event handler — see README → Content Filter → Limitations.",
      { model, node, status, location: data?.error?.location, messageCount: messages?.length },
    )
  } else if (isFilterModule && status === 400) {
    LOG.warn("Content filter blocked the request", {
      model,
      node,
      status,
      reason: data?.error?.message,
    })
  }

  metrics.llmInvocations.add(1, { ...mAttrs, outcome: "error" })
  if (span) {
    span.setAttribute("error.type", err.constructor?.name || "Error")
    span.setStatus({ code: 2, message: err.message })
    span.recordException(err)
  }
}

// ─── Shared LLM span helpers ─────────────────────────────────────────────────

/** Extract plain text from LangChain message content (string or content-block array). */
export function extractText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("")
  }
  return String(content ?? "")
}

/** Map LangChain message role to OpenAI role string. */
export function toRole(msg) {
  const t = msg._getType?.()
  if (t === "human") return "user"
  if (t === "ai") return "assistant"
  return t || "user"
}

/**
 * Set common LLM span start attributes.
 */
export function setLLMSpanStartAttrs(
  span,
  { model, provider, params, streaming, cacheControl, node, messages },
) {
  span.setAttribute("gen_ai.operation.name", "chat")
  span.setAttribute("gen_ai.provider.name", provider)
  span.setAttribute("gen_ai.request.model", model)
  span.setAttribute("mlflow.message.format", "langchain-js")
  if (params?.temperature != null)
    span.setAttribute("gen_ai.request.temperature", params.temperature)
  if (params?.max_tokens != null) span.setAttribute("gen_ai.request.max_tokens", params.max_tokens)
  if (cds.context?.["agent.context.id"])
    span.setAttribute("gen_ai.conversation.id", cds.context["agent.context.id"])
  if (streaming) span.setAttribute("gen_ai.request.stream", true)
  if (node) span.setAttribute("agent.llm.node", node)
  if (cacheControl) span.setAttribute("gen_ai.request.cache_control", true)

  // MLflow inputs: chat messages for Chat tab
  if ((cds.env.agents?.mlflow || LOG._debug) && messages) {
    const mlMessages = messages.map((m) => ({ role: toRole(m), content: extractText(m.content) }))
    setSpanAttrs(span, mlflowAttrs("LLM", { model, provider, inputs: { messages: mlMessages } }))
    if (LOG._debug) {
      span.setAttribute("gen_ai.input.messages", JSON.stringify(messages.map((m) => m.content)))
    }
  }
}

/**
 * Set gen_ai.response.*, gen_ai.usage.*, MLflow outputs on span end.
 */
export function setLLMSpanEndAttrs(span, { model, provider, tokenUsage, outputContent, response }) {
  if (LOG._debug && outputContent) {
    span.setAttribute("gen_ai.output.messages", outputContent)
  }

  // gen_ai.response.* attributes
  if (response) {
    if (response.finishReason)
      span.setAttribute("gen_ai.response.finish_reasons", [response.finishReason])
    if (response.model) span.setAttribute("gen_ai.response.model", response.model)
    if (response.id) span.setAttribute("gen_ai.response.id", response.id)
    if (response.finishReason === "length" || response.finishReason === "max_tokens") {
      span.setAttribute("gen_ai.response.truncated", true)
    }
    if (response.toolCalls?.length > 0) {
      span.setAttribute("gen_ai.response.tool_calls", JSON.stringify(response.toolCalls))
    }
  }

  if (tokenUsage) {
    setTokenUsage(span, tokenUsage)
    if (cds.env.agents?.mlflow) {
      const mlOpts = { model, provider, tokenUsage: { ...tokenUsage, reasoning_tokens: undefined } }
      if (outputContent) {
        mlOpts.outputs = {
          choices: [{ message: { role: "assistant", content: outputContent } }],
        }
      }
      setSpanAttrs(span, mlflowAttrs("LLM", mlOpts))
      return
    }
  }

  // MLflow outputs without token usage
  if (cds.env.agents?.mlflow && outputContent) {
    setSpanAttrs(
      span,
      mlflowAttrs("LLM", {
        model,
        provider,
        outputs: { choices: [{ message: { role: "assistant", content: outputContent } }] },
      }),
    )
  }
}

export function setTokenUsage(span, tokenUsage) {
  span.setAttribute("gen_ai.usage.input_tokens", tokenUsage.input_tokens)
  span.setAttribute("gen_ai.usage.output_tokens", tokenUsage.output_tokens)
  span.setAttribute("gen_ai.usage.total_tokens", tokenUsage.total_tokens)

  if (tokenUsage.cache_read_input_tokens != null)
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", tokenUsage.cache_read_input_tokens)
  if (tokenUsage.cache_creation_input_tokens != null)
    span.setAttribute(
      "gen_ai.usage.cache_creation.input_tokens",
      tokenUsage.cache_creation_input_tokens,
    )
  if (tokenUsage.reasoning_tokens != null)
    span.setAttribute("gen_ai.usage.reasoning.output_tokens", tokenUsage.reasoning_tokens)
}

/**
 * Convert LangChain UsageMetadata to flat token usage format.
 */
export function convertUsageData(usage) {
  if (!usage) return undefined
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    cache_creation_input_tokens: usage.input_token_details?.cache_creation,
    cache_read_input_tokens: usage.input_token_details?.cache_read,
    reasoning_tokens: usage.output_token_details?.reasoning,
  }
}
