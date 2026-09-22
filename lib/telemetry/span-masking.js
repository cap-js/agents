import cds from "@sap/cds"
import { pseudonymizeToolResult } from "../masking/structured/index.js"

const LOG = cds.log("agents")
const REGISTERED = Symbol.for("@cap-js/agents:trace-scrubber-registered")

/**
 * Returns true when PII should be replaced with pseudonym tokens in spans.
 * Returns false when tokens should be resolved back to originals (resolveInTraces mode).
 */
function mustMaskValues() {
  if (cds.env.agents?.masking?.resolveInTraces) {
    LOG._debug &&
      LOG.debug(
        `Resolving pseudonymized values in OTEL spans because "cds.env.agents.masking.resolveInTraces" = true`,
      )
    return false
  }
  return true
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

function resolveValue(value, session) {
  if (typeof value === "string") return session.resolveText(value)
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, session))
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) value[k] = resolveValue(v, session)
    return value
  }
  return value
}

function transformAttributes(attrs, session, mask) {
  if (!attrs) return
  const transform = mask ? scrubValue : resolveValue
  for (const [key, value] of Object.entries(attrs)) attrs[key] = transform(value, session)
}

function parseJson(value) {
  if (typeof value !== "string") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function scrubToolOutputs(span) {
  const attrs = span.attributes
  if (attrs?.["mlflow.spanType"] !== "TOOL") return
  const rawOutputs = parseJson(attrs["mlflow.spanOutputs"])
  // rawOutputs is the parsed value of the JSON-stringified tool outputs.
  // Only TOON-encoded strings (the success path) can be scrubbed; skip objects (error case).
  if (typeof rawOutputs !== "string") return
  const inputs = parseJson(attrs["mlflow.spanInputs"]) ?? {}

  // forLlm=false: also scrub fields annotated with @Common.Masked to avoid PII in traces.
  const scrubbed = pseudonymizeToolResult({
    content: rawOutputs,
    toolName: attrs["gen_ai.tool.call.id"],
    cql: inputs.cql,
    forLlm: false,
  })
  attrs["mlflow.spanOutputs"] = JSON.stringify(scrubbed)
  if (attrs["gen_ai.tool.call.result"] === rawOutputs) attrs["gen_ai.tool.call.result"] = scrubbed
}

export class MaskingSpanProcessor {
  onStart() {}

  onEnd(span) {
    if (!cds.env.agents?.masking) return
    const session = cds.context?.["agent.pseudonyms"]
    if (!session) return

    const mask = mustMaskValues()
    if (mask) scrubToolOutputs(span)

    transformAttributes(span.attributes, session, mask)
    for (const event of span.events ?? []) transformAttributes(event.attributes, session, mask)
    if (span.status?.message) {
      span.status.message = mask
        ? session.scrubText(span.status.message)
        : session.resolveText(span.status.message)
    }
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
    if (!registerFirst(delegate, new MaskingSpanProcessor())) {
      LOG.warn("Trace scrubbing: no TracerProvider with span processor support")
      return
    }
    delegate[REGISTERED] = true
  } catch (err) {
    LOG.warn("Trace scrubbing setup failed", { error: err.message })
  }
}
