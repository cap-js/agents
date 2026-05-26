const cds = require("@sap/cds")

const NOOP_METER = (() => {
  const noop = () => ({ add() {}, record() {} })
  return { createCounter: noop, createHistogram: noop, createUpDownCounter: noop }
})()

let _otel,
  _otelResolved = false
function otel() {
  if (_otelResolved) return _otel
  try {
    _otel = require("@opentelemetry/api")
    _otelResolved = true
  } catch {
    // Not available yet — don't cache, retry on next access
    return null
  }
  return _otel
}

let _meter
function getMeter() {
  if (_meter) return _meter
  const api = otel()
  if (api) {
    _meter = api.metrics.getMeter("@cap-js/a2a")
    return _meter
  }
  // Return noop but don't cache — retry next time in case OTel loads later
  return NOOP_METER
}

let _requestDuration, _requestsTotal, _errorsTotal, _concurrentExecs, _completedTotal, _agentActions
let _llmInputTokens, _llmOutputTokens, _llmInvocations, _toolInvocations

module.exports = {
  get requestDuration() {
    return (_requestDuration ??= getMeter().createHistogram("a2a.request.duration", {
      description: "End-to-end A2A request duration",
      unit: "ms",
    }))
  },
  get requestsTotal() {
    return (_requestsTotal ??= getMeter().createCounter("a2a.requests.total", {
      description: "Total inbound A2A requests",
    }))
  },
  get errorsTotal() {
    return (_errorsTotal ??= getMeter().createCounter("a2a.errors.total", {
      description: "A2A requests resulting in error",
    }))
  },
  get concurrentExecutions() {
    return (_concurrentExecs ??= getMeter().createUpDownCounter("a2a.executions.concurrent", {
      description: "Currently active workflow executions",
    }))
  },
  get workflowsCompleted() {
    return (_completedTotal ??= getMeter().createCounter("a2a.workflows.completed", {
      description: "Number of completed A2A agent workflows",
    }))
  },
  get agentActions() {
    return (_agentActions ??= getMeter().createCounter("agent_actions", {
      description: "Successful workflow completions per tenant",
    }))
  },
  get llmInputTokens() {
    return (_llmInputTokens ??= getMeter().createCounter("a2a.llm.input_tokens", {
      description: "LLM input tokens consumed",
    }))
  },
  get llmOutputTokens() {
    return (_llmOutputTokens ??= getMeter().createCounter("a2a.llm.output_tokens", {
      description: "LLM output tokens generated",
    }))
  },
  get llmInvocations() {
    return (_llmInvocations ??= getMeter().createCounter("a2a.llm.invocations", {
      description: "LLM invocation count",
    }))
  },
  get toolInvocations() {
    return (_toolInvocations ??= getMeter().createCounter("a2a.tool.invocations", {
      description: "Tool invocation count",
    }))
  },

  /** Common attributes for all A2A metrics */
  attrs(srv) {
    return {
      "sap.tenantId": cds.context?.tenant || "anonymous",
      "a2a.service": typeof srv === "string" ? srv : srv.name,
    }
  },

  /**
   * Get active OTel span. Returns null if OTel is unavailable or no span is active.
   * Callers should use `if (span)` — both null and undefined are falsy.
   */
  getActiveSpan() {
    return otel()?.trace.getActiveSpan() || null
  },

  /** Get OTel tracer for @cap-js/a2a (or null if unavailable) */
  getTracer() {
    return otel()?.trace.getTracer("@cap-js/a2a") || null
  },
}
