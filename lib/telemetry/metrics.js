import cds from "@sap/cds"
import { createRequire } from "node:module"

const NOOP_METER = (() => {
  const noop = () => ({ add() {}, record() {} })
  return { createCounter: noop, createHistogram: noop, createUpDownCounter: noop }
})()

let _otel
try {
  // Synchronous require avoids top-level await which blocks module graph
  // resolution and causes issues with CDS plugin loading order.
  const require = createRequire(import.meta.url)
  _otel = require("@opentelemetry/api")
} catch {
  _otel = null
}

function getMeter() {
  return _otel ? _otel.metrics.getMeter("@cap-js/agent") : NOOP_METER
}

const meter = getMeter()

export const requestDuration = meter.createHistogram("agent.request.duration", {
  description: "End-to-end agent request duration",
  unit: "ms",
})
export const requestsTotal = meter.createCounter("agent.requests.total", {
  description: "Total inbound agent requests",
})
export const errorsTotal = meter.createCounter("agent.errors.total", {
  description: "Agent requests resulting in error",
})
export const concurrentExecutions = meter.createUpDownCounter("agent.executions.concurrent", {
  description: "Currently active workflow executions",
})
export const workflowsCompleted = meter.createCounter("agent.workflows.completed", {
  description: "Number of completed agent workflows",
})
export const agentActions = meter.createCounter("agent_actions", {
  description: "Successful workflow completions per tenant",
})
export const llmInputTokens = meter.createCounter("agent.llm.input_tokens", {
  description: "LLM input tokens consumed",
})
export const llmOutputTokens = meter.createCounter("agent.llm.output_tokens", {
  description: "LLM output tokens generated",
})
export const llmInvocations = meter.createCounter("agent.llm.invocations", {
  description: "LLM invocation count",
})
export const toolInvocations = meter.createCounter("agent.tool.invocations", {
  description: "Tool invocation count",
})

/** Common attributes for all agent metrics */
export function attrs(srv) {
  return {
    "sap.tenantId": cds.context?.tenant || "anonymous",
    "agent.service": typeof srv === "string" ? srv : srv.name,
  }
}

/**
 * Get active OTel span. Returns null if OTel is unavailable or no span is active.
 */
export function getActiveSpan() {
  return _otel?.trace.getActiveSpan() || null
}

/** Get OTel tracer for @cap-js/agent (or null if unavailable) */
export function getTracer() {
  return _otel?.trace.getTracer("@cap-js/agent") || null
}

/** Create the active_users ObservableGauge with given observation callback */
export function createActiveUsersGauge(callback) {
  if (!_otel) return null
  const gauge = meter.createObservableGauge("active_users", {
    description: "Active users per tenant and agent service (24h rolling window)",
  })
  gauge.addCallback(callback)
  return gauge
}
