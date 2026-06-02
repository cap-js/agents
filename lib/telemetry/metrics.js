import cds from "@sap/cds"

const NOOP_METER = (() => {
  const noop = () => ({ add() {}, record() {} })
  return { createCounter: noop, createHistogram: noop, createUpDownCounter: noop }
})()

let _otel
try {
  _otel = await import("@opentelemetry/api")
} catch {
  _otel = null
}

function getMeter() {
  return _otel ? _otel.metrics.getMeter("@cap-js/a2a") : NOOP_METER
}

const meter = getMeter()

export const requestDuration = meter.createHistogram("a2a.request.duration", {
  description: "End-to-end A2A request duration",
  unit: "ms",
})
export const requestsTotal = meter.createCounter("a2a.requests.total", {
  description: "Total inbound A2A requests",
})
export const errorsTotal = meter.createCounter("a2a.errors.total", {
  description: "A2A requests resulting in error",
})
export const concurrentExecutions = meter.createUpDownCounter("a2a.executions.concurrent", {
  description: "Currently active workflow executions",
})
export const workflowsCompleted = meter.createCounter("a2a.workflows.completed", {
  description: "Number of completed A2A agent workflows",
})
export const agentActions = meter.createCounter("agent_actions", {
  description: "Successful workflow completions per tenant",
})
export const llmInputTokens = meter.createCounter("a2a.llm.input_tokens", {
  description: "LLM input tokens consumed",
})
export const llmOutputTokens = meter.createCounter("a2a.llm.output_tokens", {
  description: "LLM output tokens generated",
})
export const llmInvocations = meter.createCounter("a2a.llm.invocations", {
  description: "LLM invocation count",
})
export const toolInvocations = meter.createCounter("a2a.tool.invocations", {
  description: "Tool invocation count",
})

/** Common attributes for all A2A metrics */
export function attrs(srv) {
  return {
    "sap.tenantId": cds.context?.tenant || "anonymous",
    "a2a.service": typeof srv === "string" ? srv : srv.name,
  }
}

/**
 * Get active OTel span. Returns null if OTel is unavailable or no span is active.
 */
export function getActiveSpan() {
  return _otel?.trace.getActiveSpan() || null
}

/** Get OTel tracer for @cap-js/a2a (or null if unavailable) */
export function getTracer() {
  return _otel?.trace.getTracer("@cap-js/a2a") || null
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
