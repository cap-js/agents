import cds from "@sap/cds"
import * as metrics from "./metrics.js"
import { mlflowAttrs, setSpanAttrs } from "./mlflow/index.js"

const LOG = cds.log("agents")

// ─── Patching ────────────────────────────────────────────────────────────────

/** Symbol marking our own instrumented classes — patch skips these */
export const INSTRUMENTED = Symbol.for("@cap-js/agents:instrumented")

/** Symbol marking a prototype as already patched */
const PATCHED = Symbol.for("@cap-js/agents:patched")

export async function patchLangChain() {
  await patchChatModel()
  await patchTools()
  await patchRunnableLambda()
  await patchRunnableSequence()
  LOG.debug("LangChain tracing patches applied")
}

// ─── BaseChatModel (extracted to chat-tracing.js) ────────────────────────────

import { patchChatModel } from "./chat-tracing.js"

// ─── StructuredTool (extracted to tool-tracing.js) ───────────────────────────

import { patchTools } from "./tool-tracing.js"

// ─── RunnableLambda ───────────────────────────────────────────────────────────

async function patchRunnableLambda() {
  try {
    const mod = await import("@langchain/core/runnables")
    if (mod.RunnableLambda?.prototype) _patchRunnableLambdaProto(mod.RunnableLambda.prototype)

    // Also patch CJS prototype
    try {
      const { createRequire } = await import("node:module")
      const req = createRequire(import.meta.url)
      const cjs = req("@langchain/core/runnables")
      if (cjs.RunnableLambda?.prototype) _patchRunnableLambdaProto(cjs.RunnableLambda.prototype)
    } catch {
      /* CJS not available */
    }
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

    // Also patch CJS prototype
    try {
      const { createRequire } = await import("node:module")
      const req = createRequire(import.meta.url)
      const cjs = req("@langchain/core/runnables")
      if (cjs.RunnableSequence?.prototype)
        _patchRunnableSequenceProto(cjs.RunnableSequence.prototype)
    } catch {
      /* CJS not available */
    }
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
