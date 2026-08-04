/**
 * LangChain monkey-patching for OpenTelemetry tracing.
 *
 * Patches BaseChatModel.invoke, StructuredTool.invoke, RunnableLambda.invoke,
 * and RunnableSequence.invoke to create OTel spans for custom graphs.
 *
 * Patches BOTH CJS and ESM exports (LangGraph uses ESM internally,
 * which resolves to a different prototype than CJS require()).
 *
 * Gated by cds.env.agents.trace_langchain (default: true).
 * Classes instrumented by lib/llm.js are skipped (no double-spanning).
 */
import cds from "@sap/cds"
import * as metrics from "./metrics.js"
import { audit } from "../utils/utils.js"
import { mlflowAttrs, setSpanAttrs } from "./mlflow.js"

const LOG = cds.log("agent")

// ─── Shared LLM span helpers (used by tracing patch + aicore.js) ─────────────

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
 * @param {object} span
 * @param {{ model: string, provider: string, params?: object, streaming?: boolean, cacheControl?: boolean, node?: string, messages?: Array }} opts
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
 * @param {object} span
 * @param {{ model: string, provider: string, cacheControl?: boolean, tokenUsage?: object, rawUsage?: object, outputContent?: string, response?: { finishReason?: string, model?: string, id?: string, toolCalls?: Array } }} opts
 */
export function setLLMSpanEndAttrs(
  span,
  { model, provider, cacheControl, tokenUsage, rawUsage, outputContent, response },
) {
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

  // gen_ai.usage.* attributes (OTel semconv)
  if (tokenUsage) {
    const inTok = tokenUsage.input_tokens ?? tokenUsage.prompt_tokens
    const outTok = tokenUsage.output_tokens ?? tokenUsage.completion_tokens
    if (inTok != null) span.setAttribute("gen_ai.usage.input_tokens", inTok)
    if (outTok != null) span.setAttribute("gen_ai.usage.output_tokens", outTok)

    // Prompt caching (Claude)
    const details = rawUsage?.prompt_tokens_details || tokenUsage.prompt_tokens_details
    if (cacheControl && details) {
      if (details.cached_tokens)
        span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cached_tokens)
      if (details.cache_creation_tokens)
        span.setAttribute("gen_ai.usage.cache_creation.input_tokens", details.cache_creation_tokens)
    }
    // Reasoning tokens (o1, gpt-5, etc.)
    const reasoning = (rawUsage?.completion_tokens_details || tokenUsage.completion_tokens_details)
      ?.reasoning_tokens
    if (reasoning) span.setAttribute("gen_ai.usage.reasoning.output_tokens", reasoning)
  }

  // MLflow span outputs
  if (!cds.env.agents?.mlflow) return
  const mlOpts = { model, provider }
  if (tokenUsage) {
    const tu = { ...tokenUsage }
    const details = rawUsage?.prompt_tokens_details || tokenUsage.prompt_tokens_details
    if (cacheControl && details) {
      if (details.cached_tokens) tu.cache_read_input_tokens = details.cached_tokens
      if (details.cache_creation_tokens)
        tu.cache_creation_input_tokens = details.cache_creation_tokens
    }
    mlOpts.tokenUsage = tu
  }
  if (outputContent) {
    mlOpts.outputs = {
      choices: [{ message: { role: "assistant", content: outputContent.slice(0, 1000) } }],
    }
  }
  setSpanAttrs(span, mlflowAttrs("LLM", mlOpts))
}

// ─── Patching ────────────────────────────────────────────────────────────────

/** Symbol marking our own instrumented classes — patch skips these */
export const INSTRUMENTED = Symbol.for("@cap-js/agents:instrumented")

/** Symbol marking a prototype as already patched */
const PATCHED = Symbol.for("@cap-js/agents:patched")

/** OTel SpanKind constants */
const SPAN_KIND_CLIENT = 3 // SpanKind.CLIENT

export async function patchLangChain() {
  await patchChatModel()
  await patchTools()
  await patchRunnableLambda()
  await patchRunnableSequence()
  LOG.debug("LangChain tracing patches applied")
}

// ─── BaseChatModel ────────────────────────────────────────────────────────────

async function patchChatModel() {
  try {
    const mod = await import("@langchain/core/language_models/chat_models")
    if (mod.BaseChatModel?.prototype) _patchChatModelProto(mod.BaseChatModel.prototype)

    import("@langchain/core/language_models/chat_models")
      .then((esm) => {
        if (esm.BaseChatModel?.prototype) _patchChatModelProto(esm.BaseChatModel.prototype)
      })
      .catch(() => {})
  } catch (err) {
    LOG.error("Failed to patch BaseChatModel for tracing", { error: err.message })
  }
}

function _patchChatModelProto(proto) {
  if (proto[PATCHED]) return
  const original = proto.invoke
  if (typeof original !== "function") {
    LOG.warn("BaseChatModel.invoke not found — tracing patch skipped")
    return
  }

  proto.invoke = async function (input, opts) {
    // Skip our own instrumented classes (class-level flag) and any instance
    // explicitly marked to opt out (instance-level flag, e.g. the content-filter
    // probe model, which is an internal call that would otherwise emit a
    // duplicate, poorly attributed "chat <ctor>" span shadowing the real one).
    if (this.constructor[INSTRUMENTED] || this[INSTRUMENTED]) {
      return original.call(this, input, opts)
    }

    const tracer = metrics.getTracer()
    const model = this.model || this.constructor.name

    const invoke = async (span) => {
      if (span) {
        setLLMSpanStartAttrs(span, {
          model,
          provider: "langchain",
          messages: Array.isArray(input) ? input : undefined,
        })
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, input, opts)
        const duration = Date.now() - t0
        const usage = result.usage_metadata
        const finishReason = result.response_metadata?.finish_reason
        if (span) {
          setLLMSpanEndAttrs(span, {
            model,
            provider: "langchain",
            tokenUsage: usage,
            outputContent: result.content ? extractText(result.content) : undefined,
            response: {
              finishReason,
              model: result.response_metadata?.model_name || result.response_metadata?.model,
              id: result.response_metadata?.id || result.id,
              toolCalls: result.tool_calls?.map((tc) => ({ name: tc.name, args: tc.args })),
            },
          })
        }
        // Detect max_tokens truncation: "length" (OpenAI) or "max_tokens" (Anthropic)
        if (finishReason === "length" || finishReason === "max_tokens") {
          LOG.warn("LLM response truncated: output_tokens reached max_tokens limit", {
            model,
            output_tokens: usage?.output_tokens,
          })
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
              model,
              iteration: opts?.configurable?._iteration ?? cds.context?.["agent.iteration"],
              toolCalls: result.tool_calls?.map((tc) => ({ name: tc.name, args: tc.args })),
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              duration,
            },
          })
        }

        return result
      } catch (err) {
        if (span) {
          span.setAttribute("error.type", err.constructor?.name || "Error")
          span.setStatus({ code: 2, message: err.message })
        }
        throw err
      } finally {
        if (span) span.end()
      }
    }

    if (tracer) {
      return tracer.startActiveSpan(`chat ${model}`, { kind: SPAN_KIND_CLIENT }, (span) =>
        invoke(span),
      )
    }
    return invoke(null)
  }
  proto[PATCHED] = true
}

// ─── StructuredTool ───────────────────────────────────────────────────────────

async function patchTools() {
  try {
    const mod = await import("@langchain/core/tools")
    if (mod.StructuredTool?.prototype) _patchToolsProto(mod.StructuredTool.prototype)

    import("@langchain/core/tools")
      .then((esm) => {
        if (esm.StructuredTool?.prototype) _patchToolsProto(esm.StructuredTool.prototype)
      })
      .catch(() => {})
  } catch (err) {
    LOG.error("Failed to patch StructuredTool for tracing", { error: err.message })
  }
}

function _patchToolsProto(proto) {
  if (proto[PATCHED]) return
  const original = proto.invoke
  if (typeof original !== "function") {
    LOG.warn("StructuredTool.invoke not found — tracing patch skipped")
    return
  }

  proto.invoke = async function (args, config) {
    if (this[INSTRUMENTED]) return original.call(this, args, config)

    const tracer = metrics.getTracer()
    const toolName = this.name || this.constructor.name

    const invoke = async (span) => {
      if (span) {
        span.setAttribute("gen_ai.operation.name", "execute_tool")
        span.setAttribute("gen_ai.provider.name", "langchain")
        span.setAttribute("gen_ai.tool.call.id", toolName)
        setSpanAttrs(span, mlflowAttrs("TOOL", { inputs: args, functionName: toolName }))
        if (LOG._debug) span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(args))
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, args, config)
        const duration = Date.now() - t0
        if (span) {
          span.setAttribute("gen_ai.tool.call.outcome", "success")
          if (LOG._debug) {
            span.setAttribute(
              "gen_ai.tool.call.result",
              typeof result === "string" ? result : JSON.stringify(result),
            )
          }
        }

        metrics.toolInvocations.add(1, {
          "sap.tenantId": cds.context?.tenant || "anonymous",
          "agent.service": config?.configurable?._service || cds.context?.["agent.service"],
          tool: toolName,
          outcome: "success",
        })

        // Audit: record tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
        if (taskId) {
          const resultStr = typeof result === "string" ? result : JSON.stringify(result)
          audit("ToolInvocation", {
            data: {
              taskId,
              service: config?.configurable?._service || cds.context?.["agent.service"],
              tool: toolName,
              args,
              outcome: "success",
              result: resultStr?.slice(0, 2000),
              duration,
            },
          })
        }

        return result
      } catch (err) {
        const duration = Date.now() - t0
        if (span) {
          span.setAttribute("gen_ai.tool.call.outcome", "error")
          span.setAttribute("error.type", err.constructor?.name || "Error")
          span.setStatus({ code: 2, message: err.message })
        }

        metrics.toolInvocations.add(1, {
          "sap.tenantId": cds.context?.tenant || "anonymous",
          "agent.service": config?.configurable?._service || cds.context?.["agent.service"],
          tool: toolName,
          outcome: "error",
        })

        // Audit: record failed tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
        if (taskId) {
          audit("ToolInvocation", {
            data: {
              taskId,
              service: config?.configurable?._service || cds.context?.["agent.service"],
              tool: toolName,
              args,
              outcome: "error",
              error: err.message,
              duration,
            },
          })
        }

        throw err
      } finally {
        if (span) span.end()
      }
    }

    if (tracer) {
      return tracer.startActiveSpan(`execute_tool DynamicStructuredTool ${toolName}`, (span) =>
        invoke(span),
      )
    }
    return invoke(null)
  }
  proto[PATCHED] = true
}

// ─── RunnableLambda ───────────────────────────────────────────────────────────

async function patchRunnableLambda() {
  try {
    const mod = await import("@langchain/core/runnables")
    if (mod.RunnableLambda?.prototype) _patchRunnableLambdaProto(mod.RunnableLambda.prototype)

    import("@langchain/core/runnables")
      .then((esm) => {
        if (esm.RunnableLambda?.prototype) _patchRunnableLambdaProto(esm.RunnableLambda.prototype)
      })
      .catch(() => {})
  } catch (err) {
    LOG.error("Failed to patch RunnableLambda for tracing", { error: err.message })
  }
}

function _patchRunnableLambdaProto(proto) {
  if (proto[PATCHED]) return
  const original = proto.invoke
  if (typeof original !== "function") {
    LOG.warn("RunnableLambda.invoke not found — tracing patch skipped")
    return
  }

  proto.invoke = async function (input, config) {
    const tracer = metrics.getTracer()
    if (!tracer) return original.call(this, input, config)

    const name = this.name || config?.runName || this.func?.name || "anonymous"
    return tracer.startActiveSpan(`task RunnableLambda ${name}`, async (span) => {
      span.setAttribute("gen_ai.operation.name", "invoke_workflow")
      span.setAttribute("gen_ai.provider.name", "langchain")
      setSpanAttrs(span, mlflowAttrs("CHAIN", { functionName: name }))
      if (LOG._debug) span.setAttribute("gen_ai.input.messages", JSON.stringify(input))
      try {
        const result = await original.call(this, input, config)
        if (LOG._debug) {
          span.setAttribute(
            "gen_ai.output.messages",
            typeof result === "string" ? result : JSON.stringify(result),
          )
        }
        return result
      } catch (err) {
        span.setAttribute("error.type", err.constructor?.name || "Error")
        span.setStatus({ code: 2, message: err.message })
        throw err
      } finally {
        span.end()
      }
    })
  }
  proto[PATCHED] = true
}

// ─── RunnableSequence ─────────────────────────────────────────────────────────

async function patchRunnableSequence() {
  try {
    const mod = await import("@langchain/core/runnables")
    if (mod.RunnableSequence?.prototype) _patchRunnableSequenceProto(mod.RunnableSequence.prototype)

    import("@langchain/core/runnables")
      .then((esm) => {
        if (esm.RunnableSequence?.prototype)
          _patchRunnableSequenceProto(esm.RunnableSequence.prototype)
      })
      .catch((err) => {
        LOG.warn("Failed to patch ESM RunnableSequence", { error: err.message })
      })
  } catch (err) {
    LOG.error("Failed to patch RunnableSequence for tracing", { error: err.message })
  }
}

function _patchRunnableSequenceProto(proto) {
  if (proto[PATCHED]) return
  const original = proto.invoke
  if (typeof original !== "function") {
    LOG.warn("RunnableSequence.invoke not found — tracing patch skipped")
    return
  }

  proto.invoke = async function (input, config) {
    const tracer = metrics.getTracer()
    if (!tracer) return original.call(this, input, config)

    const name = this.name || config?.runName || this.first?.name || "RunnableSequence"
    return tracer.startActiveSpan(`workflow RunnableSequence ${name}`, async (span) => {
      span.setAttribute("gen_ai.operation.name", "invoke_workflow")
      span.setAttribute("gen_ai.provider.name", "langchain")
      setSpanAttrs(span, mlflowAttrs("CHAIN", { functionName: name }))
      if (LOG._debug) span.setAttribute("gen_ai.input.messages", JSON.stringify(input))
      try {
        const result = await original.call(this, input, config)
        if (LOG._debug) {
          span.setAttribute(
            "gen_ai.output.messages",
            typeof result === "string" ? result : JSON.stringify(result),
          )
        }
        return result
      } catch (err) {
        span.setAttribute("error.type", err.constructor?.name || "Error")
        span.setStatus({ code: 2, message: err.message })
        throw err
      } finally {
        span.end()
      }
    })
  }
  proto[PATCHED] = true
}
