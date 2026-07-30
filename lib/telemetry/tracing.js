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
    const modelName = this.modelName || this.model || this.constructor.name

    const invoke = async (span) => {
      if (span) {
        span.setAttribute("gen_ai.operation.name", "chat")
        span.setAttribute("gen_ai.provider.name", "langchain")
        span.setAttribute("gen_ai.request.model", modelName)
        setSpanAttrs(span, mlflowAttrs("LLM", { model: modelName, provider: "langchain" }))
        if (LOG._debug) {
          const content = Array.isArray(input) ? input.map((m) => m.content) : input
          span.setAttribute("gen_ai.input.messages", JSON.stringify(content))
        }
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, input, opts)
        const duration = Date.now() - t0
        const usage = result.usage_metadata
        const finishReason = result.response_metadata?.finish_reason
        if (span) {
          if (usage?.input_tokens)
            span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens)
          if (usage?.output_tokens)
            span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
          if (finishReason) span.setAttribute("gen_ai.response.finish_reasons", [finishReason])
          const responseModel =
            result.response_metadata?.model_name || result.response_metadata?.model
          if (responseModel) span.setAttribute("gen_ai.response.model", responseModel)
          const responseId = result.response_metadata?.id || result.id
          if (responseId) span.setAttribute("gen_ai.response.id", responseId)
          if (result.tool_calls?.length > 0) {
            span.setAttribute(
              "gen_ai.response.tool_calls",
              JSON.stringify(result.tool_calls.map((tc) => ({ name: tc.name, args: tc.args }))),
            )
          }
          if (LOG._debug) {
            span.setAttribute("gen_ai.output.messages", JSON.stringify(result.content))
          }
          // MLflow Databricks: combined token usage + outputs
          if (usage) {
            const mlOpts = { model: modelName, provider: "langchain", tokenUsage: usage }
            if (result.content) mlOpts.outputs = result.content
            setSpanAttrs(span, mlflowAttrs("LLM", mlOpts))
          }
        }
        // Detect max_tokens truncation: "length" (OpenAI) or "max_tokens" (Anthropic)
        if (finishReason === "length" || finishReason === "max_tokens") {
          LOG.warn("LLM response truncated: output_tokens reached max_tokens limit", {
            model: modelName,
            output_tokens: usage?.output_tokens,
          })
          if (span) span.setAttribute("gen_ai.response.truncated", true)
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
      return tracer.startActiveSpan(`chat ${modelName}`, { kind: SPAN_KIND_CLIENT }, (span) =>
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
