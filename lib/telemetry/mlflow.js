/**
 * MLflow Databricks span attribute helpers for @cap-js/agents.
 *
 * Adds mlflow.* attributes to existing OTel spans so the MLflow OTLP
 * ingestion endpoint can assemble them into proper MLflow traces.
 *
 * All functions return {} when cds.env.agents.mlflow is falsy (zero overhead).
 *
 * The exporter itself is configured via setupMlflowExporter() as a
 * RoutingSpanProcessor that lazily creates per-experiment-ID exporters —
 * existing exporters (Dynatrace, Cloud Logging, Grafana, etc.) continue
 * to work unchanged.
 */
import cds from "@sap/cds"

/**
 * Resolve the MLflow experiment ID for the current request context.
 *
 * Resolution order:
 *   1. @Core.SchemaVersion annotation on the service (feature-toggleable via cds.context.model)
 *   2. cds.env.requires["databricks-mlflow"].credentials.MLFLOW_EXPERIMENT_ID
 *   3. process.env.MLFLOW_EXPERIMENT_ID
 *
 * MLflow requires experiment IDs to be numeric (int64). Throws if annotation
 * value is not a valid integer string.
 */
function resolveExperimentId() {
  // Read from @Core.SchemaVersion on the active service (feature-toggle-aware)
  const serviceName = cds.context?.["agent.service"]
  if (serviceName) {
    const definition =
      cds.context?.model?.definitions?.[serviceName] || cds.services?.[serviceName]?.definition
    const annotated = definition?.["@Core.SchemaVersion"]
    if (annotated) {
      const id = String(annotated)
      if (!/^\d+$/.test(id)) {
        throw new Error(
          `@Core.SchemaVersion on "${serviceName}" must be a numeric string (MLflow experiment ID requires int64). Got: "${id}"`,
        )
      }
      return id
    }
  }

  // Fallback: credentials / env
  const creds = cds.env.requires?.["databricks-mlflow"]?.credentials
  return creds?.MLFLOW_EXPERIMENT_ID || process.env.MLFLOW_EXPERIMENT_ID
}

/**
 * Build mlflow.* span attributes for a given span type.
 * @param {"LLM"|"AGENT"|"TOOL"|"CHAIN"|"RETRIEVER"} spanType
 * @param {{ inputs?: any, outputs?: any, model?: string, provider?: string, functionName?: string, tokenUsage?: object }} [opts]
 * @returns {Record<string, string>} Attributes to set on span, or {} when disabled
 */
export function mlflowAttrs(spanType, opts = {}) {
  if (!cds.env.agents?.mlflow) return {}
  const experimentId = resolveExperimentId()
  const attrs = {}
  if (experimentId) attrs["mlflow.experimentId"] = String(experimentId)
  attrs["mlflow.spanType"] = spanType
  if (opts.model) attrs["mlflow.llm.model"] = String(opts.model)
  if (opts.provider) attrs["mlflow.llm.provider"] = String(opts.provider)
  if (opts.functionName) attrs["mlflow.spanFunctionName"] = String(opts.functionName)
  if (opts.inputs !== undefined) attrs["mlflow.spanInputs"] = JSON.stringify(opts.inputs)
  if (opts.outputs !== undefined) attrs["mlflow.spanOutputs"] = JSON.stringify(opts.outputs)
  if (opts.tokenUsage) attrs["mlflow.chat.tokenUsage"] = JSON.stringify(opts.tokenUsage)
  return attrs
}

/**
 * Build mlflow trace-level tag attributes (set on root/workflow span).
 * Uses mlflow.traceTag.* prefix so MLflow server extracts them as trace tags.
 * Also sets OTel semconv user.id and session.id which MLflow reads natively.
 * @returns {Record<string, string>} Attributes to set on root span, or {} when disabled
 */
export function mlflowTraceAttrs() {
  if (!cds.env.agents?.mlflow) return {}
  const session = String(cds.context?.["agent.context.id"] || "")
  const user = String(cds.context?.user?.id || "")
  const tenant = String(cds.context?.tenant || "")
  return {
    // OTel semconv keys MLflow reads natively for user/session display
    "session.id": session,
    "user.id": user,
    // mlflow.traceTag.* prefix for custom trace tags
    "mlflow.traceTag.session": session,
    "mlflow.traceTag.user": user,
    "mlflow.traceTag.tenant": tenant,
  }
}

/**
 * Spread attributes object onto an OTel span (null-safe).
 * Coerces all values to strings to prevent [object Object] in downstream systems.
 * @param {import("@opentelemetry/api").Span | null} span
 * @param {Record<string, string>} attrs
 */
export function setSpanAttrs(span, attrs) {
  if (!cds.env.agents?.mlflow) return
  if (!span) return
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) span.setAttribute(k, v)
  }
}

/**
 * SpanProcessor that routes spans to per-experiment-ID BatchSpanProcessors.
 * Lazily creates an OTLPTraceExporter for each unique mlflow.experimentId
 * seen on spans, so different services (or feature-toggled @Core.SchemaVersion
 * values) export to the correct MLflow experiment.
 */
class RoutingSpanProcessor {
  constructor({ url, token, BatchSpanProcessor, OTLPTraceExporter }) {
    this._url = url
    this._token = token
    this._BatchSpanProcessor = BatchSpanProcessor
    this._OTLPTraceExporter = OTLPTraceExporter
    this._processors = new Map()
  }

  onStart() {}

  onEnd(span) {
    const expId = span.attributes?.["mlflow.experimentId"]
    if (!expId) return
    this._getOrCreate(expId).onEnd(span)
  }

  _getOrCreate(experimentId) {
    if (this._processors.has(experimentId)) return this._processors.get(experimentId)
    const exporter = new this._OTLPTraceExporter({
      url: this._url,
      headers: {
        Authorization: `Bearer ${this._token}`,
        "x-mlflow-experiment-id": experimentId,
      },
    })
    const proc = new this._BatchSpanProcessor(exporter)
    this._processors.set(experimentId, proc)
    return proc
  }

  async forceFlush() {
    await Promise.all([...this._processors.values()].map((p) => p.forceFlush()))
  }

  async shutdown() {
    await Promise.all([...this._processors.values()].map((p) => p.shutdown()))
    this._processors.clear()
  }
}

/**
 * Register MLflow OTLP RoutingSpanProcessor.
 * Does NOT replace existing exporters — Dynatrace, Cloud Logging, Grafana all keep working.
 * Reads credentials from cds.env.requires["databricks-mlflow"].credentials.
 * No-op when credentials are missing.
 *
 * Experiment routing is per-span: each span's mlflow.experimentId attribute
 * (set by mlflowAttrs() from @Core.SchemaVersion) determines which exporter
 * receives it. New experiment IDs create exporters lazily at runtime.
 */
export async function setupMlflowExporter() {
  if (!cds.env.agents?.mlflow) return

  const LOG = cds.log("agent")
  try {
    const creds = cds.env.requires?.["databricks-mlflow"]?.credentials || {}
    const host = creds.DATABRICKS_HOST || process.env.DATABRICKS_HOST
    const token = creds.DATABRICKS_TOKEN || process.env.DATABRICKS_TOKEN
    const mlflowEndpoint =
      creds.MLFLOW_OTLP_ENDPOINT || (host && `${host.replace(/\/$/, "")}/v1/traces`)

    if (!mlflowEndpoint || !token) {
      LOG.warn(
        "MLflow: credentials missing (DATABRICKS_HOST + DATABRICKS_TOKEN or MLFLOW_OTLP_ENDPOINT) — export disabled",
      )
      return
    }

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider

    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base")
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto")

    const routing = new RoutingSpanProcessor({
      url: mlflowEndpoint,
      token,
      BatchSpanProcessor,
      OTLPTraceExporter,
    })

    if (delegate.addSpanProcessor) {
      // OTEL SDK v1
      delegate.addSpanProcessor(routing)
    } else if (delegate._activeSpanProcessor?._spanProcessors) {
      // OTEL SDK v2: no addSpanProcessor — push into MultiSpanProcessor
      delegate._activeSpanProcessor._spanProcessors.push(routing)
    } else {
      LOG.warn(
        "MLflow: no TracerProvider with addSpanProcessor — ensure @cap-js/telemetry is loaded",
      )
      return
    }
    LOG.info("MLflow: routing span processor added (per-experiment export)", {
      endpoint: mlflowEndpoint,
    })
  } catch (err) {
    LOG.error("MLflow: failed to configure OTLP export", { error: err.message })
  }
}
