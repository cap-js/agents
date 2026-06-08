/**
 * LangChain monkey-patching for OpenTelemetry tracing.
 *
 * Patches BaseChatModel.invoke, StructuredTool.invoke, RunnableLambda.invoke,
 * and RunnableSequence.invoke to create OTel spans for custom graphs.
 *
 * Patches BOTH CJS and ESM exports (LangGraph uses ESM internally,
 * which resolves to a different prototype than CJS require()).
 *
 * Gated by cds.env.a2a.trace_langchain (default: true).
 * Classes instrumented by lib/llm.js are skipped (no double-spanning).
 */
import cds from "@sap/cds"
import * as metrics from "./metrics.js"
import { audit } from "../utils.js"

const LOG = cds.log("a2a")

/** Symbol marking our own instrumented classes — patch skips these */
export const INSTRUMENTED = Symbol.for("@cap-js/a2a:instrumented")

/** Symbol marking a prototype as already patched */
const PATCHED = Symbol.for("@cap-js/a2a:patched")

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
    if (this.constructor[INSTRUMENTED]) return original.call(this, input, opts)

    const tracer = metrics.getTracer()
    const modelName = this.modelName || this.model || this.constructor.name

    const invoke = async (span) => {
      if (span) {
        span.setAttribute("gen_ai.operation.name", "chat")
        span.setAttribute("gen_ai.provider.name", "langchain")
        span.setAttribute("gen_ai.request.model", modelName)
        span.setAttribute("a2a.span.kind", "chat")
        if (LOG._debug) {
          const content = Array.isArray(input) ? input.map((m) => m.content) : input
          span.setAttribute("gen_ai.input.messages", JSON.stringify(content))
          span.setAttribute("a2a.entity.input", JSON.stringify(content))
        }
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, input, opts)
        const duration = Date.now() - t0
        const usage = result.usage_metadata
        if (span) {
          if (usage?.input_tokens)
            span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens)
          if (usage?.output_tokens)
            span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
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
            span.setAttribute("a2a.entity.output", JSON.stringify(result.content))
          }
        }

        // Audit: record agent decision (LLM invocation + tool selection)
        const taskId = opts?.configurable?._taskId || cds.context?.["a2a.task.id"]
        if (taskId) {
          audit("AgentDecision", {
            data: {
              taskId,
              contextId:
                opts?.configurable?.thread_id?.split(":")[1] || cds.context?.["a2a.context.id"],
              service: opts?.configurable?._service || cds.context?.["a2a.service"],
              model: modelName,
              iteration: opts?.configurable?._iteration ?? cds.context?.["a2a.iteration"],
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
        span.setAttribute("a2a.span.kind", "tool")
        span.setAttribute("a2a.tool.name", toolName)
        if (LOG._debug) span.setAttribute("a2a.entity.input", JSON.stringify(args))
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, args, config)
        const duration = Date.now() - t0
        if (span) {
          span.setAttribute("a2a.tool.outcome", "success")
          if (LOG._debug) {
            span.setAttribute(
              "a2a.entity.output",
              typeof result === "string" ? result : JSON.stringify(result),
            )
          }
        }

        metrics.toolInvocations.add(1, {
          "sap.tenantId": cds.context?.tenant || "anonymous",
          "a2a.service": config?.configurable?._service || cds.context?.["a2a.service"],
          tool: toolName,
          outcome: "success",
        })

        // Audit: record tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["a2a.task.id"]
        if (taskId) {
          const resultStr = typeof result === "string" ? result : JSON.stringify(result)
          audit("ToolInvocation", {
            data: {
              taskId,
              service: config?.configurable?._service || cds.context?.["a2a.service"],
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
          span.setAttribute("a2a.tool.outcome", "error")
          span.setAttribute("error.type", err.constructor?.name || "Error")
          span.setStatus({ code: 2, message: err.message })
        }

        metrics.toolInvocations.add(1, {
          "sap.tenantId": cds.context?.tenant || "anonymous",
          "a2a.service": config?.configurable?._service || cds.context?.["a2a.service"],
          tool: toolName,
          outcome: "error",
        })

        // Audit: record failed tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["a2a.task.id"]
        if (taskId) {
          audit("ToolInvocation", {
            data: {
              taskId,
              service: config?.configurable?._service || cds.context?.["a2a.service"],
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
      span.setAttribute("a2a.span.kind", "task")
      if (LOG._debug) span.setAttribute("a2a.entity.input", JSON.stringify(input))
      try {
        const result = await original.call(this, input, config)
        if (LOG._debug) {
          span.setAttribute(
            "a2a.entity.output",
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
      span.setAttribute("a2a.span.kind", "workflow")
      if (LOG._debug) span.setAttribute("a2a.entity.input", JSON.stringify(input))
      try {
        const result = await original.call(this, input, config)
        if (LOG._debug) {
          span.setAttribute(
            "a2a.entity.output",
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
