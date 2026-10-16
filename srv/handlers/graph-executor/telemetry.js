import cds from "@sap/cds"
import { trace } from "@opentelemetry/api"
import { partsToText, buildChatMessages } from "../../../lib/utils/message-handling.js"
import * as metrics from "../../../lib/telemetry/metrics.js"
import { mlflowAttrs, mlflowTraceAttrs, setSpanAttrs } from "../../../lib/telemetry/mlflow/index.js"
import { linkTraceToPrompt } from "../../../lib/telemetry/mlflow/tracing.js"
import { recordUsage } from "./usage.js"

function startWorkflowSpan(serviceName) {
  return metrics.getTracer()?.startSpan(`workflow CompiledStateGraph ${serviceName}`)
}

function telemetryBeforeWorkflow() {
  const requestContext = cds.context["agent"].request
  const serviceName = cds.context["agent.service"]
  const taskId = cds.context["agent.task.id"]
  const contextId = cds.context["agent.context.id"]
  metrics.concurrentExecutions.add(1, metrics.attrs(serviceName))
  const span = trace.getActiveSpan()
  if (!span) return
  span.setAttribute("gen_ai.operation.name", "invoke_agent")
  span.setAttribute("gen_ai.agent.name", serviceName)
  span.setAttribute("agent.task.id", taskId)
  span.setAttribute("agent.context.id", contextId)
  span.setAttribute("agent.service", serviceName)
  span.setAttribute("mlflow.message.format", "langchain-js")
  setSpanAttrs(
    span,
    mlflowAttrs("AGENT", {
      inputs: { messages: buildChatMessages(requestContext) },
      functionName: serviceName,
    }),
  )
  const rootSpan = cds.context["_mlflow.rootSpan"]
  rootSpan.setAttribute("agent.task.id", taskId)
  rootSpan.setAttribute("agent.context.id", contextId)
  rootSpan.setAttribute("agent.service", serviceName)
  const userText = partsToText(requestContext.userMessage?.parts)
  setSpanAttrs(
    rootSpan,
    mlflowAttrs("CHAIN", {
      functionName: rootSpan.name ?? serviceName,
      inputs:
        userText !== undefined ? { messages: [{ role: "user", content: userText }] } : undefined,
    }),
  )
  setSpanAttrs(rootSpan, mlflowTraceAttrs())
  const evalRunId = cds.context?.["_mlflow.evalRunId"]
  if (evalRunId) {
    rootSpan.setAttribute("mlflow.sourceRun", evalRunId)
    span.setAttribute("mlflow.sourceRun", evalRunId)
  }
}

function setWorkflowOutput(output) {
  const serviceName = cds.context["agent.service"]
  const span = trace.getActiveSpan()
  const outputs = { choices: [{ message: { role: "assistant", content: output } }] }
  setSpanAttrs(span, mlflowAttrs("AGENT", { outputs, functionName: serviceName }))
  setSpanAttrs(cds.context["_mlflow.rootSpan"], mlflowAttrs("CHAIN", { outputs }))
}

function finishWorkflowTelemetry({ graph, result, usageData }) {
  const serviceName = cds.context["agent.service"]
  setSpanAttrs(cds.context["_mlflow.rootSpan"], linkTraceToPrompt())
  metrics.concurrentExecutions.add(-1, metrics.attrs(serviceName))
  recordUsage({ graph, result, usageData })
}

function telemetryAfterWorkflowSuccess({ graph, result, usageData, outcome, output }) {
  if (outcome) trace.getActiveSpan()?.setAttribute("agent.outcome", outcome)
  if (output !== undefined) setWorkflowOutput(output)
  if (outcome === "completed")
    metrics.workflowsCompleted.add(1, metrics.attrs(cds.context["agent.service"]))
  finishWorkflowTelemetry({ graph, result, usageData })
}

function telemetryAfterWorkflowError({ graph, result, usageData, err }) {
  const outcome =
    err.name === "AbortError"
      ? "canceled"
      : err.name === "TimeoutError"
        ? "input-required"
        : err.quotaExceeded
          ? "quota_exceeded"
          : "failed"
  const errorCode = err.quotaExceeded
    ? "quota_exceeded"
    : err.name === "AbortError" || err.name === "TimeoutError"
      ? undefined
      : err.message?.includes("timed out")
        ? "timeout"
        : "execution_failed"
  const span = trace.getActiveSpan()
  span?.setAttribute("agent.outcome", outcome)
  span?.setStatus({ code: 2, message: err.message })
  if (errorCode) {
    metrics.errorsTotal.add(1, {
      ...metrics.attrs(cds.context["agent.service"]),
      "agent.error.code": errorCode,
    })
  }
  finishWorkflowTelemetry({ graph, result, usageData })
}

export {
  startWorkflowSpan,
  telemetryBeforeWorkflow,
  telemetryAfterWorkflowSuccess,
  telemetryAfterWorkflowError,
}
