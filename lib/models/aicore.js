import cds from "@sap/cds"
import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import { circuitBreaker, timeout } from "@sap-cloud-sdk/resilience"
import * as metrics from "../../lib/telemetry/metrics.js"
import { INSTRUMENTED } from "../../lib/telemetry/tracing.js"
import { mlflowAttrs, setSpanAttrs } from "../../lib/telemetry/mlflow.js"
import { audit } from "../../lib/utils/utils.js"

import { SystemMessage, ToolMessage, HumanMessage, AIMessage } from "@langchain/core/messages"

const LOG = cds.log("agent")

function isClaude(modelName) {
  return /anthropic|claude/i.test(modelName || "")
}

// Claude currently only supports caching of type ephemeral. TTL can differ between 5min or 1h but
// we use the 5min default
const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" }

/**
 * Marks: all system messages, the last AI message (with text content), and the last human message.
 * Converts string content to content-block arrays where needed so cache_control
 * can be attached per the Anthropic/SAP AI Core API format.
 */
function injectCacheControl(messages) {
  if (!messages || messages.length === 0) return messages

  const result = messages.map((m) => {
    // Clone to avoid mutating original
    if (m._getType?.() === "system" || m.type === "system") {
      return _withCacheControl(m)
    }
    return m
  })
  // Mark last AI message with non-empty text content (stable breakpoint for multi-turn)
  for (let i = result.length - 1; i >= 0; i--) {
    const type = result[i]._getType?.() || result[i].type
    if (type === "ai" && _hasTextContent(result[i])) {
      result[i] = _withCacheControl(result[i])
      break
    }
  }
  // Mark last human message
  for (let i = result.length - 1; i >= 0; i--) {
    const type = result[i]._getType?.() || result[i].type
    if (type === "human") {
      result[i] = _withCacheControl(result[i])
      break
    }
  }
  return result
}

/**
 * Check if a message has non-empty text content (not just tool_calls).
 */
function _hasTextContent(msg) {
  const content = msg.content
  if (typeof content === "string") return content.length > 0
  if (Array.isArray(content)) return content.some((b) => b.type === "text" && b.text?.length > 0)
  return false
}

/**
 * If content is a string, convert to [{type:"text", text, cache_control}].
 * If content is an array, add cache_control to the last text block.
 */
function _withCacheControl(msg) {
  const content = msg.content
  if (typeof content === "string") {
    // Convert to content blocks with cache_control on the block
    const newContent = [{ type: "text", text: content, cache_control: CACHE_CONTROL_EPHEMERAL }]
    return _cloneMessageWithContent(msg, newContent)
  }
  if (Array.isArray(content) && content.length > 0) {
    const newContent = [...content]
    // Find last text block and add cache_control
    for (let i = newContent.length - 1; i >= 0; i--) {
      if (newContent[i].type === "text") {
        newContent[i] = { ...newContent[i], cache_control: CACHE_CONTROL_EPHEMERAL }
        break
      }
    }
    return _cloneMessageWithContent(msg, newContent)
  }
  return msg
}

function _cloneMessageWithContent(msg, newContent) {
  const type = msg._getType?.() || msg.type
  if (type === "system") {
    return new SystemMessage({ content: newContent })
  }
  if (type === "ai") {
    return new AIMessage({ content: newContent, tool_calls: msg.tool_calls })
  }
  if (type === "human") {
    return new HumanMessage({ content: newContent })
  }
  if (type === "tool") {
    return new ToolMessage({ content: newContent, tool_call_id: msg.tool_call_id, name: msg.name })
  }
  // Fallback: shallow clone with new content
  return { ...msg, content: newContent }
}

export function flattenMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m
    // Only flatten SystemMessage and ToolMessage — the two types the SAP
    // AI Core harmonizer rejects when content is a list.
    const isSystem = SystemMessage.isInstance?.(m) || m._getType?.() === "system"
    const isTool = ToolMessage.isInstance?.(m) || m._getType?.() === "tool"
    if (!isSystem && !isTool) return m

    const parts = m.content.map((b) => {
      if (typeof b === "string") return b
      if (!b || typeof b !== "object") return ""
      if (b.type === "text") return b.text || ""
      if (b.type === "image" || b.type === "audio" || b.type === "video" || b.type === "file") {
        const mime = b.mimeType || b.mime_type || "application/octet-stream"
        const data = b.data || b.source?.data || ""
        const bytes = typeof data === "string" ? Buffer.byteLength(data, "base64") : 0
        return `[binary ${mime}, ${bytes} bytes]`
      }
      return JSON.stringify(b).slice(0, 200)
    })
    const text = parts.join("\n")

    if (isTool) {
      return new ToolMessage({
        content: text,
        tool_call_id: m.tool_call_id,
        name: m.name,
        status: m.status,
        additional_kwargs: m.additional_kwargs,
      })
    }
    return new SystemMessage({
      content: text,
      additional_kwargs: m.additional_kwargs,
      response_metadata: m.response_metadata,
    })
  })
}

/** Content filter thresholds */
const AZURE_THRESHOLDS = {
  ALLOW_SAFE: 0,
  ALLOW_SAFE_LOW: 2,
  ALLOW_SAFE_LOW_MEDIUM: 4,
  ALLOW_ALL: 6,
}

export function buildContentFilter() {
  return {
    input: {
      azure_content_safety: {
        hate: "ALLOW_SAFE_LOW",
        violence: "ALLOW_SAFE_LOW_MEDIUM",
        prompt_shield: true,
      },
    },
    output: {
      azure_content_safety: {
        hate: "ALLOW_SAFE",
        violence: "ALLOW_SAFE_LOW_MEDIUM",
      },
    },
  }
}

/**
 * Convert simplified dictionary to SDK array format.
 * Azure threshold strings are converted to numeric values.
 */
export function toSdkFilterFormat(filter) {
  const result = {}
  if (filter?.input) {
    result.input = convertFilter(filter.input)
  }
  if (filter?.output) {
    result.output = convertFilter(filter.output)
  }
  return result
}

function convertFilter(c) {
  const contentSafety = { ...c.azure_content_safety }
  for (const [key, value] of Object.entries(contentSafety)) {
    contentSafety[key] = AZURE_THRESHOLDS[value] ?? value
  }
  const converted = { ...c, azure_content_safety: contentSafety }
  return {
    filters: Object.entries(converted).map(([type, config]) => ({ type, config })),
  }
}

/**
 * Extracts text from Anthropic content-block arrays in a streaming chunk.
 *
 * @sap-ai-sdk/langchain getDeltaContent() only handles string deltas
 * (ChatDelta.content typed as string in the API spec). Anthropic returns
 * content as Array<{type,text}> — getDeltaContent() returns "" for every
 * chunk, silencing handleLLMNewToken. We extract the text manually.
 *
 * @param {object} chunk - LangChain streaming chunk from OrchestrationClient
 * @returns {string} extracted text, or empty string if not a content-block array
 */
export function extractTextFromContentBlocks(chunk) {
  const rawContent =
    chunk._data?.intermediate_results?.llm?.choices?.[0]?.delta?.content ??
    chunk._data?.final_result?.choices?.[0]?.delta?.content
  if (!Array.isArray(rawContent)) return ""
  return rawContent
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

export default class InstrumentedOrchestrationClient extends OrchestrationClient {
  constructor(name, model, options) {
    const { modelName, params, deepAgent } = options
    const flatten = options.flatten ?? (deepAgent ? true : false)

    LOG.debug("Initializing LLM", { model: modelName, deepAgent: !!deepAgent })

    let { contentFilter } = options
    contentFilter =
      contentFilter === true ? buildContentFilter() : (contentFilter ?? buildContentFilter())

    // only output filters (input handled by contentFilterMiddleware)
    const filtering = toSdkFilterFormat({ output: contentFilter.output })

    super(
      {
        promptTemplating: { model: { name: modelName, params } },
        ...(filtering && { filtering }),
        // deep-agent models need streaming:true; managed agents keep the default (false) for bindTools()
        ...(flatten ? { streaming: true } : {}),
      },
      {
        onFailedAttempt: (err) => {
          // Abort retries when circuit breaker is open (otherwise pRetry delays ~30-60s)
          if (err.code === "EOPENBREAKER" || err.message === "Breaker is open") {
            throw err
          }
        },
      },
    )
    this.name = name
    this.options = { ...options, contentFilter, flatten }
  }

  init() {}

  async _generate(messages, opts, runManager) {
    const { modelName, params, flatten } = this.options
    const tracer = metrics.getTracer()
    const node = opts?.runName || (flatten ? "unknown" : "agent")
    const mAttrs = {
      "sap.tenantId": cds.context?.tenant || "anonymous",
      "agent.service": cds.context?.["agent.service"],
      model: modelName,
      node,
    }

    const claudeModel = isClaude(modelName)

    const invoke = async (span) => {
      if (span) {
        span.setAttribute("gen_ai.operation.name", "chat")
        span.setAttribute("gen_ai.provider.name", "sap-ai-core")
        span.setAttribute("gen_ai.request.model", modelName)
        if (params?.temperature != null)
          span.setAttribute("gen_ai.request.temperature", params.temperature)
        if (params?.max_tokens != null)
          span.setAttribute("gen_ai.request.max_tokens", params.max_tokens)
        if (cds.context?.["agent.context.id"])
          span.setAttribute("gen_ai.conversation.id", cds.context["agent.context.id"])
        if (this.streaming) span.setAttribute("gen_ai.request.stream", true)
        span.setAttribute("agent.llm.node", node)
        if (claudeModel) span.setAttribute("gen_ai.request.cache_control", true)
        if (cds.env.agents?.mlflow || LOG._debug) {
          const inputSummary = JSON.stringify(messages.map((m) => m.content))
          // MLflow Databricks: LLM span type + model info + inputs summary
          setSpanAttrs(
            span,
            mlflowAttrs("LLM", {
              model: modelName,
              provider: "sap-ai-core",
              inputs: inputSummary,
            }),
          )
          if (LOG._debug) {
            span.setAttribute("gen_ai.input.messages", inputSummary)
          }
        }
      }

      let result
      const t0 = Date.now()
      try {
        const llmTimeout = cds.env.agents?.pool?.maxLLMCallTimeoutMs || 120000
        const middleware = [timeout(llmTimeout), circuitBreaker()]
        // Response-capture middleware: extract raw usage for cache + reasoning token details
        middleware.unshift((options) => async (arg) => {
          const res = await options.fn(arg)
          this._lastRawUsage = res?.data?.final_result?.usage || null
          return res
        })

        opts = {
          ...opts,
          customRequestConfig: {
            ...opts?.customRequestConfig,
            middleware,
          },
        }
        let inputMessages = flatten ? flattenMessages(messages) : messages
        // For Claude: inject cache_control on messages and last tool definition
        if (claudeModel) {
          inputMessages = injectCacheControl(inputMessages)
          // Add cache_control to last tool definition
          if (opts.tools?.length > 0) {
            const tools = [...opts.tools]
            tools[tools.length - 1] = {
              ...tools[tools.length - 1],
              cache_control: CACHE_CONTROL_EPHEMERAL,
            }
            opts = { ...opts, tools }
          }
        }
        result = await super._generate(inputMessages, opts, runManager)
      } catch (err) {
        const status = err.rootCause?.status
        const data = err.rootCause?.response?.data
        const headers = err.rootCause?.response?.headers
        const isFilterModule = /Filtering Module/i.test(data?.error?.location || "")
        const isExternalFailure = headers?.["ai-external-failure"] === "true"

        if (isFilterModule && status === 503 && isExternalFailure) {
          LOG.warn(
            "Content filter service rejected the request (likely payload too large for prompt_shield). " +
              "Disable input filter or content filtering for this service: " +
              "Disable content filtering via the buildContentFilter event handler — see README → Content Filter → Limitations.",
            {
              model: modelName,
              node,
              status,
              location: data?.error?.location,
              messageCount: messages.length,
            },
          )
        } else if (isFilterModule && status === 400) {
          // The input filter blocked the request (e.g. detected prompt injection).
          // Content filter middleware handles recovery for managed agents.
          // DeepAgents handle input filtering via contentFilterMiddleware (separate cheap model call).
          LOG.warn("Content filter blocked the request", {
            model: modelName,
            node,
            status,
            reason: data?.error?.message,
          })
        }
        metrics.llmInvocations.add(1, { ...mAttrs, outcome: "error" })
        if (span) {
          span.setAttribute("error.type", err.constructor?.name || "Error")
          span.setStatus({ code: 2, message: err.message })
        }
        throw err
      }
      const duration = Date.now() - t0

      metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
      // Only first entry can be used as multi generations do not happen with the Orchestration API
      const usage = result.generations?.[0]?.message?.usage_metadata
      if (usage?.input_tokens) {
        metrics.llmInputTokens.add(usage.input_tokens, mAttrs)
        if (span) span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens)
      }
      if (usage?.output_tokens) {
        metrics.llmOutputTokens.add(usage.output_tokens, mAttrs)
        if (span) span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
      }
      // Prompt caching: extract cache_creation and cache_read tokens from raw usage (Claude)
      if (span && claudeModel && this._lastRawUsage) {
        const details = this._lastRawUsage.prompt_tokens_details
        if (details?.cached_tokens) {
          span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cached_tokens)
        }
        if (details?.cache_creation_tokens) {
          span.setAttribute(
            "gen_ai.usage.cache_creation.input_tokens",
            details.cache_creation_tokens,
          )
        }
      }
      // Reasoning tokens (o1, gpt-5, etc.)
      if (span && this._lastRawUsage?.completion_tokens_details?.reasoning_tokens) {
        span.setAttribute(
          "gen_ai.usage.reasoning.output_tokens",
          this._lastRawUsage.completion_tokens_details.reasoning_tokens,
        )
      }
      const msg = result.generations?.[0]?.message
      const finishReason = result.generations?.[0]?.generationInfo?.finish_reason
      if (span) {
        if (finishReason) span.setAttribute("gen_ai.response.finish_reasons", [finishReason])
        const responseModel = result.llmOutput?.model
        if (responseModel) span.setAttribute("gen_ai.response.model", responseModel)
        const responseId = msg?.response_metadata?.id || msg?.id
        if (responseId) span.setAttribute("gen_ai.response.id", responseId)
        if (msg?.tool_calls?.length > 0) {
          span.setAttribute(
            "gen_ai.response.tool_calls",
            JSON.stringify(msg.tool_calls.map((tc) => ({ name: tc.name, args: tc.args }))),
          )
        }
      }
      // Detect max_tokens truncation: "length" (OpenAI) or "max_tokens" (Anthropic)
      if (finishReason === "length" || finishReason === "max_tokens") {
        LOG.warn("LLM response truncated: output_tokens reached max_tokens limit", {
          model: modelName,
          node,
          max_tokens: params?.max_tokens,
          output_tokens: usage?.output_tokens,
        })
        if (span) span.setAttribute("gen_ai.response.truncated", true)
      }
      if (span && LOG._debug) {
        const output = JSON.stringify(result.generations?.[0]?.message?.content)
        span.setAttribute("gen_ai.output.messages", output)
      }
      // MLflow Databricks: combined token usage + outputs
      if (span && usage) {
        const tokenUsage = { ...usage }
        // Add cache token details for MLflow visualization (Claude models)
        if (claudeModel && this._lastRawUsage) {
          const details = this._lastRawUsage.prompt_tokens_details
          if (details?.cached_tokens) tokenUsage.cache_read_input_tokens = details.cached_tokens
          if (details?.cache_creation_tokens)
            tokenUsage.cache_creation_input_tokens = details.cache_creation_tokens
        }
        const mlOpts = { model: modelName, provider: "sap-ai-core", tokenUsage }
        if (msg?.content) mlOpts.outputs = msg.content
        setSpanAttrs(span, mlflowAttrs("LLM", mlOpts))
      }

      // Audit: record agent decision (LLM invocation + tool selection)
      const taskId = opts?.configurable?._taskId || cds.context?.["agent.task.id"]
      if (taskId) {
        audit("AgentDecision", {
          data: {
            taskId,
            contextId:
              opts?.configurable?.thread_id?.split(":")[1] || cds.context?.["agent.context.id"],
            service: opts?.configurable?._service || cds.context?.["agent.service"],
            model: modelName,
            iteration: opts?.configurable?._iteration ?? cds.context?.["agent.iteration"],
            toolCalls: msg?.tool_calls?.map((tc) => ({ name: tc.name, args: tc.args })),
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            duration,
          },
        })
      }

      return result
    }

    if (tracer) {
      return tracer.startActiveSpan(
        `chat ${modelName}`,
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

  /**
   * Override _streamResponseChunks for three reasons:
   *
   * 1. Message flattening — same reason _generate is overridden: Anthropic content
   *    arrays must be flattened to plain strings before reaching AI Core.
   *
   * 2. Claude prompt caching — injectCacheControl must be applied here too;
   *    without it cache_control is silently skipped on the streaming path.
   *
   * 3. Content-block extraction — @sap-ai-sdk/langchain getDeltaContent() only handles
   *    string deltas (ChatDelta.content: string in spec). Anthropic returns an array of
   *    content blocks; getDeltaContent() returns "" for every chunk, silencing
   *    handleLLMNewToken. We extract the text manually after each yield.
   *    Unfixed in @sap-ai-sdk/langchain 2.11.0 (confirmed latest at time of writing).
   */
  async *_streamResponseChunks(messages, opts, runManager) {
    const { modelName, flatten } = this.options
    const claudeModel = isClaude(modelName)
    let inputMessages = flatten ? flattenMessages(messages) : messages
    // For Claude: inject cache_control on messages — same as _generate does.
    // Without this, prompt caching is silently skipped on the streaming path.
    if (claudeModel) inputMessages = injectCacheControl(inputMessages)
    for await (const chunk of super._streamResponseChunks(inputMessages, opts, runManager)) {
      if (chunk.text) {
        yield chunk
        continue
      }
      const text = extractTextFromContentBlocks(chunk)
      if (text) {
        // Clone chunk before mutating to avoid corrupting upstream references
        const patchedMessage = chunk.message
          ? Object.assign(Object.create(Object.getPrototypeOf(chunk.message)), chunk.message, {
              content: text,
            })
          : chunk.message
        yield Object.assign(Object.create(Object.getPrototypeOf(chunk)), chunk, {
          text,
          ...(patchedMessage !== undefined && { message: patchedMessage }),
        })
        continue
      }
      yield chunk
    }
  }
}
InstrumentedOrchestrationClient[INSTRUMENTED] = true
InstrumentedOrchestrationClient._is_service_class = true
