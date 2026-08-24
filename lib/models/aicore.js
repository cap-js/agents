import cds from "@sap/cds"
import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import { circuitBreaker, timeout } from "@sap-cloud-sdk/resilience"

import { SystemMessage, ToolMessage, HumanMessage, AIMessage } from "@langchain/core/messages"
import { ms4 } from "../utils/utils.js"

const LOG = cds.log("agents")

class _InstrumentedOrchestrationClient extends OrchestrationClient {
  constructor(name, options) {
    const { model, deepAgent, streaming, destinationName, resourceGroup = process.env.AICORE_RESOURCE_GROUP } = options
    const flatten = options.flatten ?? (deepAgent ? true : false)

    // Restore pre-72ef6fa params resolution: caller > deep-agent default > root
    // cds.env.agents.params. Without this, AI Core silently applies its own
    // defaults (temperature ≈ 1, verbose model → repeated max_tokens truncation
    // and extra ReAct iterations — see PR #188 review).
    const params =
      options.params || (deepAgent ? { max_tokens: 4096, temperature: 0 } : cds.env.agents?.params)

    LOG.debug("Initializing LLM", { model, deepAgent: !!deepAgent })

    let { contentFilter } = options
    contentFilter =
      contentFilter === true ? buildContentFilter() : (contentFilter ?? buildContentFilter())

    // only output filters (input handled by contentFilterMiddleware)
    const filtering = toSdkFilterFormat({ output: contentFilter?.output })

    // When AICore is behind a BTP destination (not bound as service instance),
    // pass destinationName + resourceGroup to the SDK. The SDK resolves the
    // destination via BTP Destination Service and uses it for all API calls.
    const deploymentConfig = destinationName
      ? { resourceGroup: resourceGroup || "default" }
      : resourceGroup
        ? { resourceGroup }
        : undefined
    const destination = destinationName ? { destinationName } : undefined

    super(
      {
        promptTemplating: { model: { name: model, params } },
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
      deploymentConfig,
      destination,
    )
    this.name = name
    this.options = { ...options, params, contentFilter, flatten }
  }

  async _generate(messages, opts, runManager) {
    const { model, flatten } = this.options
    opts = _withMiddleware(this, opts)
    const prepared = _prepareMessages(messages, { flatten, model, opts })
    return super._generate(prepared.inputMessages, prepared.opts, runManager)
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
    const { model, flatten } = this.options
    opts = _withMiddleware(this, opts)
    const prepared = _prepareMessages(messages, { flatten, model, opts })
    const inputMessages = prepared.inputMessages
    opts = prepared.opts

    let turnHasToolCall = false
    for await (const chunk of super._streamResponseChunks(inputMessages, opts, runManager)) {
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
  }
}

export default _InstrumentedOrchestrationClient

// ─── SDK helpers ─────────────────────────────────────────────────────────────

function isClaude(model) {
  return /anthropic|claude/i.test(model || "")
}

/**
 * Inject timeout and circuit breaker middleware into opts.
 */
function _withMiddleware(instance, opts) {
  const llmTimeout = ms4(cds.env.agents?.pool?.maxLLMCallTimeout || "120s")
  const middleware = [timeout(llmTimeout), circuitBreaker()]
  return {
    ...opts,
    customRequestConfig: { ...opts?.customRequestConfig, middleware },
  }
}

/**
 * Prepare input messages: flatten, normalize assistant content, inject cache_control.
 * Returns { inputMessages, opts } (opts may be mutated with cache_control on last tool).
 */
function _prepareMessages(messages, { flatten, model, opts }) {
  let inputMessages = flatten ? flattenMessages(messages) : messages
  inputMessages = normalizeAssistantContent(inputMessages)
  if (isClaude(model)) {
    inputMessages = injectCacheControl(inputMessages)
    if (opts?.tools?.length > 0) {
      const tools = [...opts.tools]
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: CACHE_CONTROL_EPHEMERAL,
      }
      opts = { ...opts, tools }
    }
  }
  return { inputMessages, opts }
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
