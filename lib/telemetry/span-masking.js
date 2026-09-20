import cds from "@sap/cds"
import { SESSION_KEY, pseudonymizeToolResult } from "../pseudonymize/helpers.js"

const LOG = cds.log("agents")
const REGISTERED = Symbol.for("@cap-js/agents:trace-scrubber-registered")

function maskValues() {
  if (cds.env.agents?.masking?.resolveInTraces) {
    LOG._debug &&
      LOG.debug(
        `Skipping pseudonymization of text in OTEL spans because "cds.env.agents.masking.resolveInTraces" = true`,
      )
    return false
  }
  return true
}
function currentSession() {
  return cds.context?.[SESSION_KEY] ?? null
}

function scrubValue(value, session) {
  if (typeof value === "string") return session.scrubText(value)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, session))
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) value[k] = scrubValue(v, session)
    return value
  }
  return value
}

function scrubAttributes(attrs, session) {
  if (!attrs) return
  for (const [key, value] of Object.entries(attrs)) attrs[key] = scrubValue(value, session)
}

function parseJson(value) {
  if (typeof value !== "string") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function scrubToolOutputs(span, session) {
  const attrs = span.attributes
  if (attrs?.["mlflow.spanType"] !== "TOOL") return
  const rawOutputs = parseJson(attrs["mlflow.spanOutputs"])
  if (typeof rawOutputs !== "string") return

  const inputs = parseJson(attrs["mlflow.spanInputs"]) ?? {}
  const srvName = cds.context?.["agent.service"]
  const srv = cds.services?.[srvName]
  const model = cds.context?.model ?? srv?.model
  if (!srv || !model) return

  const scrubbed = pseudonymizeToolResult({
    content: rawOutputs,
    toolName: attrs["gen_ai.tool.call.id"],
    cql: inputs.cql ?? inputs.sql,
    model,
    srv,
    session,
  })
  attrs["mlflow.spanOutputs"] = JSON.stringify(scrubbed)
  if (attrs["gen_ai.tool.call.result"] === rawOutputs) attrs["gen_ai.tool.call.result"] = scrubbed
}

export class PseudonymizationSpanProcessor {
  onStart() {}

  onEnd(span) {
    const session = currentSession()
    if (!session) return
    scrubToolOutputs(span, session)
    scrubAttributes(span.attributes, session)
    for (const event of span.events ?? []) scrubAttributes(event.attributes, session)
    if (span.status?.message) span.status.message = session.scrubText(span.status.message)
  }

  forceFlush() {
    return Promise.resolve()
  }

  shutdown() {
    return Promise.resolve()
  }
}

function registerFirst(delegate, processor) {
  // @opentelemetry/sdk-trace-base >= 2.0: internal MultiSpanProcessor holds processors in _spanProcessors
  if (Array.isArray(delegate._activeSpanProcessor?._spanProcessors)) {
    delegate._activeSpanProcessor._spanProcessors.unshift(processor)
    return true
  }
  // @opentelemetry/sdk-trace-base ^1.x: BasicTracerProvider exposes _registeredSpanProcessors directly
  if (Array.isArray(delegate._registeredSpanProcessors)) {
    delegate._registeredSpanProcessors.unshift(processor)
    return true
  }
  // @opentelemetry/sdk-trace-base ^1.x fallback: public addSpanProcessor API (appends, not prepends)
  if (typeof delegate.addSpanProcessor === "function") {
    delegate.addSpanProcessor(processor)
    return true
  }
  return false
}

export async function setupTraceScrubbing() {
  if (!cds.env.agents?.masking) return
  try {
    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider
    if (delegate[REGISTERED]) return
    if (!registerFirst(delegate, new PseudonymizationSpanProcessor())) {
      LOG.warn("Trace scrubbing: no TracerProvider with span processor support")
      return
    }
    delegate[REGISTERED] = true
  } catch (err) {
    LOG.warn("Trace scrubbing setup failed", { error: err.message })
  }
}
