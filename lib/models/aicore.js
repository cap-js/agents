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

/**
 * AI Core's assistant template only accepts `text` content blocks, but after a
 * tool round-trip LangChain puts a `tool_call` block in the content array (the
 * call itself already travels in top-level `tool_calls`). We join the text
 * blocks and drop the rest. Clone-and-overwrite rather than `new AIMessage(...)`:
 * that constructor re-materializes the tool_call block from `tool_calls` when
 * content is empty, undoing the strip.
 */
export function normalizeAssistantContent(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m
    const isAI = AIMessage.isInstance?.(m) || m._getType?.() === "ai" || m.type === "ai"
    if (!isAI) return m
    const text = m.content
      .filter((b) => (typeof b === "string" ? true : b?.type === "text"))
      .map((b) => (typeof b === "string" ? b : (b.text ?? "")))
      .join("")
    const clone = Object.assign(Object.create(Object.getPrototypeOf(m)), m)
    clone.content = text
    if (clone.lc_kwargs) clone.lc_kwargs = { ...clone.lc_kwargs, content: text }
    return clone
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
 * Reads the per-chunk LLM `delta` for choice 0. On the streaming path the SDK
 * yields a ChatGenerationChunk with no `_data` — the raw payload lives on
 * `message.additional_kwargs.intermediate_results` — so we check both.
 */
function getChunkDelta(chunk) {
  const ir =
    chunk.message?.additional_kwargs?.intermediate_results ?? chunk._data?.intermediate_results
  return ir?.llm?.choices?.[0]?.delta ?? chunk._data?.final_result?.choices?.[0]?.delta
}

/**
 * Extracts text from Anthropic content-block arrays in a streaming chunk.
 *
 * @sap-ai-sdk/langchain getDeltaContent() only handles string deltas
 * (ChatDelta.content typed as string in the API spec). Anthropic returns
 * content as Array<{type,text}> — getDeltaContent() returns "" for every
 * chunk, silencing handleLLMNewToken. We extract the text manually.
 */
export function extractTextFromContentBlocks(chunk) {
  const rawContent = getChunkDelta(chunk)?.content
  if (!Array.isArray(rawContent)) return ""
  return rawContent
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

/**
 * Extracts reasoning ("thinking") text from a streaming chunk. AI Core streams
 * Claude reasoning tokens in a sibling `delta.reasoning_content` field (array of
 * `{ content, signature }`), NOT in `delta.content`, and the SDK never surfaces it.
 */
export function extractReasoningFromChunk(chunk) {
  const reasoning = getChunkDelta(chunk)?.reasoning_content
  if (!Array.isArray(reasoning)) return ""
  return reasoning.map((b) => (typeof b === "string" ? b : (b?.content ?? ""))).join("")
}

// High indices keep text/reasoning off the tool-call block indices (0..N).
const TEXT_BLOCK_INDEX = 100
const REASONING_BLOCK_INDEX = 101

/**
 * Builds the content-block parts for a streaming chunk.
 *
 * NOTE ON PRIMING: an earlier version pushed an empty `{ text: "", index: 100 }`
 * placeholder alongside the first real text delta of a turn — a workaround for
 * langchain's `TextContentStream` (via `convertChunksToEvents`), which reads
 * only `content-block-delta` events and would otherwise drop the first text.
 * We removed it because langchain-core's `_mergeLists` (`messages/base.js`)
 * matches array items by `index`: the empty priming block became the merge
 * target for every subsequent delta while the real first delta was orphaned
 * at position 1 in the aggregated content array. Downstream readers that join
 * the array in order (e.g. `messageText` in graph-executor.js) then produce
 * scrambled text with the first delta stranded at the end.
 *
 * No code path in this repo consumes chunks via `convertChunksToEvents`/
 * `TextContentStream`, so priming is unnecessary here. If such a consumer is
 * ever introduced, add priming inside that consumer rather than on the wire.
 *
 * `suppressText` drops the text block for chunks in a tool-calling turn — the
 * planning/reasoning text emitted alongside a tool_use block is not the
 * user-facing answer and must not leak into the final response.
 */
export function buildStreamBlocks(text, reasoning, suppressText) {
  const blocks = []
  if (reasoning) blocks.push({ type: "reasoning", reasoning, index: REASONING_BLOCK_INDEX })
  if (text && !suppressText) blocks.push({ type: "text", text, index: TEXT_BLOCK_INDEX })
  return blocks
}

/**
 * Shallow-clones the chunk with new content blocks, preserving tool_call_chunks
 * so tool calls survive alongside text/reasoning on the same chunk.
 */
function patchChunkContent(chunk, blocks) {
  const patchedMessage = chunk.message
    ? Object.assign(Object.create(Object.getPrototypeOf(chunk.message)), chunk.message, {
        content: blocks,
      })
    : chunk.message
  return Object.assign(Object.create(Object.getPrototypeOf(chunk)), chunk, {
    text: blocks.filter((b) => b.type === "text").at(-1)?.text ?? "",
    ...(patchedMessage !== undefined && { message: patchedMessage }),
  })
}

export default class InstrumentedOrchestrationClient extends OrchestrationClient {
  constructor(name, model, options) {
    const { modelName, deepAgent, streaming } = options
    const flatten = options.flatten ?? (deepAgent ? true : false)

    // Restore pre-72ef6fa params resolution: caller > deep-agent default > root
    // cds.env.agents.params. Without this, AI Core silently applies its own
    // defaults (temperature ≈ 1, verbose model → repeated max_tokens truncation
    // and extra ReAct iterations — see PR #188 review).
    const params =
      options.params || (deepAgent ? { max_tokens: 4096, temperature: 0 } : cds.env.agents?.params)

    LOG.debug("Initializing LLM", { model: modelName, deepAgent: !!deepAgent })

    let { contentFilter } = options
    contentFilter =
      contentFilter === true ? buildContentFilter() : (contentFilter ?? buildContentFilter())

    // only output filters (input handled by contentFilterMiddleware)
    const filtering = toSdkFilterFormat({ output: contentFilter?.output })

    super(
      {
        promptTemplating: { model: { name: modelName, params } },
        ...(filtering && { filtering }),
        // `streaming` controls the SDK's auto-stream-and-concatenate in _generate()
        // (i.e. direct model.invoke() calls). It does NOT gate LangGraph token
        // streaming — that is driven by graph.stream(streamMode:["messages"]) via a
        // streaming callback handler + our overridden _streamResponseChunks, and
        // works for every agent regardless of this flag (deep or managed alike).
        // Default on; `streaming: false` opts out.
        ...(streaming !== false ? { streaming: true } : {}),
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
    this.options = { ...options, params, contentFilter, flatten }
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
        inputMessages = normalizeAssistantContent(inputMessages)
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
   * 1. Message flattening / normalization — same as _generate: content arrays
   *    must be reduced to text before reaching AI Core's assistant template.
   * 2. Claude prompt caching — injectCacheControl must run here too, or
   *    cache_control is silently skipped on the streaming path.
   * 3. Content extraction — @sap-ai-sdk/langchain getDeltaContent() only handles
   *    string deltas; Anthropic streams content-block arrays (and reasoning in a
   *    sibling field), so we re-extract and re-emit them via buildStreamBlocks().
   */
  async *_streamResponseChunks(messages, opts, runManager) {
    const { modelName, params, flatten } = this.options
    const claudeModel = isClaude(modelName)
    let inputMessages = flatten ? flattenMessages(messages) : messages
    inputMessages = normalizeAssistantContent(inputMessages)
    if (claudeModel) inputMessages = injectCacheControl(inputMessages)

    // Mirror the "chat <model>" span _generate creates, so telemetry is also
    // recorded on the streaming path.
    const tracer = metrics.getTracer()
    const span = tracer ? tracer.startSpan(`chat ${modelName}`, { kind: 3 /* CLIENT */ }) : null
    if (span) {
      span.setAttribute("gen_ai.operation.name", "chat")
      span.setAttribute("gen_ai.provider.name", "sap-ai-core")
      span.setAttribute("gen_ai.request.model", modelName)
      span.setAttribute("gen_ai.request.stream", true)
      if (params?.temperature != null)
        span.setAttribute("gen_ai.request.temperature", params.temperature)
      if (params?.max_tokens != null)
        span.setAttribute("gen_ai.request.max_tokens", params.max_tokens)
      if (cds.context?.["agent.context.id"])
        span.setAttribute("gen_ai.conversation.id", cds.context["agent.context.id"])
    }

    // finish_reason/model_name and token usage arrive on different chunks (usage
    // in a separate trailing chunk with choices:[]), so accumulate across chunks.
    const resp = {}
    let turnHasToolCall = false
    try {
      for await (const chunk of super._streamResponseChunks(inputMessages, opts, runManager)) {
        const info = chunk.generationInfo
        if (info) {
          if (info.finish_reason) resp.finish_reason = info.finish_reason
          if (info.model_name) resp.model_name = info.model_name
          if (info.id) resp.id = info.id
          if (info.token_usage) resp.token_usage = info.token_usage
        }

        if (chunk.message?.tool_call_chunks?.length > 0) turnHasToolCall = true
        const text = chunk.text || extractTextFromContentBlocks(chunk)
        const reasoning = extractReasoningFromChunk(chunk)
        const blocks = buildStreamBlocks(text, reasoning, turnHasToolCall)

        if (!blocks.length && !(text && turnHasToolCall)) {
          yield chunk
          continue
        }
        yield patchChunkContent(chunk, blocks)
      }
    } finally {
      // Set response attributes from the accumulated generationInfo — mirrors _generate()
      if (span) {
        if (resp.finish_reason)
          span.setAttribute("gen_ai.response.finish_reasons", [resp.finish_reason])
        if (resp.model_name) span.setAttribute("gen_ai.response.model", resp.model_name)
        if (resp.id) span.setAttribute("gen_ai.response.id", resp.id)
        if (resp.finish_reason === "length" || resp.finish_reason === "max_tokens") {
          span.setAttribute("gen_ai.response.truncated", true)
        }
        if (resp.token_usage) {
          const u = resp.token_usage
          if (u.prompt_tokens != null)
            span.setAttribute("gen_ai.usage.input_tokens", u.prompt_tokens)
          if (u.completion_tokens != null)
            span.setAttribute("gen_ai.usage.output_tokens", u.completion_tokens)
          // Prompt caching: cache_read + cache_creation tokens (Claude) — mirrors _generate()
          if (claudeModel) {
            const details = u.prompt_tokens_details
            if (details?.cached_tokens)
              span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cached_tokens)
            if (details?.cache_creation_tokens)
              span.setAttribute(
                "gen_ai.usage.cache_creation.input_tokens",
                details.cache_creation_tokens,
              )
          }
          // Reasoning tokens (o1, gpt-5, etc.) — mirrors _generate()
          if (u.completion_tokens_details?.reasoning_tokens)
            span.setAttribute(
              "gen_ai.usage.reasoning.output_tokens",
              u.completion_tokens_details.reasoning_tokens,
            )
        }
      }
      span?.end()
    }
  }
}
InstrumentedOrchestrationClient[INSTRUMENTED] = true
InstrumentedOrchestrationClient._is_service_class = true
