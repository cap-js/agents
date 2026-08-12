import cds from "@sap/cds"
import * as metrics from "./metrics.js"
import { mlflowAttrs, setSpanAttrs } from "./mlflow.js"
import { audit } from "../utils/utils.js"

const LOG = cds.log("agent")

/** Symbol marking our own instrumented classes — patch skips these */
const INSTRUMENTED = Symbol.for("@cap-js/agents:instrumented")

/** Symbol marking a prototype as already patched */
const PATCHED = Symbol.for("@cap-js/agents:patched")

export async function patchTools() {
  try {
    const mod = await import("@langchain/core/tools")
    if (mod.StructuredTool?.prototype) _patchToolsProto(mod.StructuredTool.prototype)

    // Also patch CJS prototype (different from ESM in dual-package modules)
    try {
      const { createRequire } = await import("node:module")
      const req = createRequire(import.meta.url)
      const cjs = req("@langchain/core/tools")
      if (cjs.StructuredTool?.prototype) _patchToolsProto(cjs.StructuredTool.prototype)
    } catch {
      /* CJS not available */
    }
  } catch (err) {
    LOG.error("Failed to patch StructuredTool for tracing", { error: err.message })
  }
}

export function _patchToolsProto(proto) {
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
        const inputs = args?.args ?? args
        setSpanAttrs(span, mlflowAttrs("TOOL", { inputs, functionName: toolName }))
        if (LOG._debug) span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(inputs))
      }
      const t0 = Date.now()
      try {
        const result = await original.call(this, args, config)
        const duration = Date.now() - t0

        const semanticError = result?.artifact?.isError === true
        const outcome = semanticError ? "error" : "success"
        const outputs = result?.content ?? result

        if (span) {
          span.setAttribute("gen_ai.tool.call.outcome", outcome)
          if (semanticError) {
            const msg = typeof outputs === "string" ? outputs : "tool returned isError"
            span.setAttribute("error.type", "Error")
            span.setStatus({ code: 2, message: msg })
            span.addEvent("exception", {
              "exception.type": "Error",
              "exception.message": msg,
            })
            setSpanAttrs(span, mlflowAttrs("TOOL", { outputs: { error: msg } }))
          } else {
            span.setStatus({ code: 1 })
            setSpanAttrs(span, mlflowAttrs("TOOL", { outputs }))
          }
          if (LOG._debug) {
            span.setAttribute("gen_ai.tool.call.result", outputs)
          }
        }

        metrics.toolInvocations.add(1, {
          "sap.tenantId": cds.context?.tenant || "anonymous",
          "agent.service": config?.configurable?._service || cds.context?.["agent.service"],
          tool: toolName,
          outcome,
        })

        // Audit: record tool invocation
        const taskId = config?.configurable?._taskId || cds.context?.["agent.task.id"]
        if (taskId) {
          const resultStr = typeof outputs === "string" ? outputs : JSON.stringify(outputs)
          audit("ToolInvocation", {
            data: {
              taskId,
              service: config?.configurable?._service || cds.context?.["agent.service"],
              tool: toolName,
              args,
              outcome,
              ...(semanticError
                ? { error: resultStr?.slice(0, 2000) }
                : { result: resultStr?.slice(0, 2000) }),
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
          span.recordException(err)
          setSpanAttrs(span, mlflowAttrs("TOOL", { outputs: { error: err.message } }))
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

        // Swallow error: return as string so LLM can see it and retry.
        // Deep agents use ToolNode with handleToolErrors (default: true) which
        // already wraps errors as ToolMessages. Custom graphs that invoke tools
        // directly also benefit from error swallowing — the graph continues and
        // the LLM can retry with a corrected query.
        return `Error: ${err.message}`
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
