/**
 * MLflow span attribute helpers for @cap-js/agents.
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
 *   2. cds.env.requires["mlflow"].credentials.MLFLOW_EXPERIMENT_ID
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
  const creds = cds.env.requires?.mlflow?.credentials || cds.env.requires?.mlflow?.credentials
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
  if (opts.tokenUsage) {
    attrs["mlflow.chat.tokenUsage"] = JSON.stringify({
      input_tokens: opts.tokenUsage.input_tokens,
      output_tokens: opts.tokenUsage.output_tokens,
      total_tokens: opts.tokenUsage.total_tokens,
      cache_creation_input_tokens: opts.tokenUsage.cache_creation_input_tokens,
      cache_read_input_tokens: opts.tokenUsage.cache_read_input_tokens,
    })
  }
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
 *
 * Supports both static headers (PAT token) and async header factories (OAuth).
 */
export class RoutingSpanProcessor {
  constructor({ url, headersConfig, ucTableName, BatchSpanProcessor, OTLPTraceExporter }) {
    this._url = url
    this._headersConfig = headersConfig
    this._ucTableName = ucTableName
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
    const ucHeader = this._ucTableName
      ? { "X-Databricks-UC-Table-Name": this._ucTableName }
      : undefined
    // Build headers — async factory or static object
    const headers =
      typeof this._headersConfig === "function"
        ? async () => ({
            ...(await this._headersConfig()),
            "x-mlflow-experiment-id": experimentId,
            ...ucHeader,
          })
        : {
            ...this._headersConfig,
            "x-mlflow-experiment-id": experimentId,
            ...ucHeader,
          }
    const exporter = new this._OTLPTraceExporter({ url: this._url, headers })
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
 * Register MLflow OTLP RoutingSpanProcessor. No-op when credentials missing.
 * Reads from cds.env.requires["mlflow"].credentials
 *
 * Auth: OAuth (clientid+clientsecret+url) takes precedence over static MLFLOW_TOKEN.
 * UC: set UC_CATALOG + UC_SCHEMA + UC_TABLE_PREFIX for Unity Catalog trace storage.
 */
export async function setupMlflowExporter() {
  if (!cds.env.agents?.mlflow) return

  const LOG = cds.log("agents")
  try {
    const creds = cds.env.requires?.mlflow?.credentials || {}
    const host = creds.MLFLOW_HOST
    const token = creds.MLFLOW_TOKEN
    const mlflowEndpoint =
      creds.MLFLOW_OTLP_ENDPOINT || (host && `${host.replace(/\/$/, "")}/v1/traces`)

    // Resolve authentication mode
    let headersConfig
    if (creds.clientid && creds.clientsecret) {
      const tokenUrl = `${creds.url ?? host.replace(/\/$/, "")}/oidc/v1/token`
      let cached = null
      let expiresAt = 0
      headersConfig = async function fetchToken() {
        // Return cached token if still valid (60s buffer before expiry)
        if (cached && Date.now() < expiresAt) return cached
        const res = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${creds.clientid}:${creds.clientsecret}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `grant_type=client_credentials&scope=all-apis`,
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          const msg = `MLFlow oauth export failed: HTTP ${res.status} ${res.statusText}`
          throw cds.error({ message: msg, response: body })
        }
        const { access_token, expires_in } = await res.json()
        cached = { Authorization: `Bearer ${access_token}` }
        expiresAt = Date.now() + (expires_in - 60) * 1000
        return cached
      }
      LOG.debug("MLflow: using OAuth client credentials authentication")
    } else if (token) {
      headersConfig = { Authorization: `Bearer ${token}` }
    } else {
      headersConfig = {}
      LOG.debug("MLflow: no auth credentials — assuming unauthenticated MLflow server")
    }

    if (!mlflowEndpoint) {
      LOG.warn(
        "MLflow: no endpoint configured (MLFLOW_HOST or MLFLOW_OTLP_ENDPOINT) — export disabled",
      )
      return
    }

    const ucCatalog = creds.UC_CATALOG
    const ucSchema = creds.UC_SCHEMA
    const ucTablePrefix = creds.UC_TABLE_PREFIX
    const ucTableName =
      ucCatalog && ucSchema && ucTablePrefix
        ? `${ucCatalog}.${ucSchema}.${ucTablePrefix}_otel_spans`
        : undefined

    const { trace } = await import("@opentelemetry/api")
    const provider = trace.getTracerProvider()
    const delegate = provider.getDelegate?.() || provider

    let BatchSpanProcessor, OTLPTraceExporter
    try {
      const { createRequire } = await import("node:module")
      const req = createRequire(process.cwd() + "/")
      ;({ BatchSpanProcessor } = req("@opentelemetry/sdk-trace-base"))
      ;({ OTLPTraceExporter } = req("@opentelemetry/exporter-trace-otlp-proto"))
    } catch (err) {
      LOG.warn(
        "MLflow: @opentelemetry/exporter-trace-otlp-proto not resolvable from the application. " +
          "Install a version matching your @cap-js/telemetry major " +
          "(v1 → ^0.57, v2 → ^0.221). Export disabled.",
        { error: err.message },
      )
      return
    }

    const routing = new RoutingSpanProcessor({
      url: mlflowEndpoint,
      headersConfig,
      ucTableName,
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
      ...(ucTableName && { ucTableName }),
    })
  } catch (err) {
    LOG.error("MLflow: failed to configure OTLP export", { error: err.message })
  }
}
