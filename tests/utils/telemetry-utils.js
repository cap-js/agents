/**
 * Shared test utilities for telemetry integration tests.
 *
 * Usage:
 *   import { setup, teardown, resetCapture, getSpansAfterRequest, findSpan, findSpans, createSendMessage, getSpanExporter } from "../utils/telemetry-utils.js"
 *   setup() // call BEFORE cds.test() to patch console.info early
 */
import cds from "@sap/cds"

/** Captured console.info output */
export const captured = []
const _originalInfo = console.info

/**
 * Patch console.info to capture telemetry output.
 * MUST be called BEFORE cds.test() so cds.log('telemetry') picks up the patched version.
 */
export function setup() {
  console.info = function (...args) {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    captured.push(msg)
    _originalInfo.apply(console, args)
  }
}

/** Restore console.info — call in afterAll() */
export function teardown() {
  console.info = _originalInfo
}

/** Reset captured output — call in beforeEach() */
export function resetCapture() {
  captured.length = 0
}

/**
 * Flush metrics and return captured console output.
 * Uses forceFlush() as the sole synchronisation — no arbitrary timeouts.
 */
export async function flushMetrics() {
  const { metrics } = await import("@opentelemetry/api")
  const meterProvider = metrics.getMeterProvider()
  if (typeof meterProvider.forceFlush !== "function") {
    throw new Error("meterProvider.forceFlush is not a function")
  }
  await meterProvider.forceFlush()
  return captured.join("")
}

/** In-memory span exporter — lazily initialized, shared per process */
let memExporter
export async function getSpanExporter() {
  if (memExporter) return memExporter
  const { trace } = await import("@opentelemetry/api")
  const { SimpleSpanProcessor, InMemorySpanExporter } =
    await import("@opentelemetry/sdk-trace-base")
  memExporter = new InMemorySpanExporter()
  const provider = trace.getTracerProvider()
  const delegate = provider.getDelegate?.() || provider
  if (delegate.addSpanProcessor) {
    // OTEL SDK v1: addSpanProcessor exists on BasicTracerProvider
    delegate.addSpanProcessor(new SimpleSpanProcessor(memExporter))
  } else if (delegate._activeSpanProcessor?._spanProcessors) {
    // OTEL SDK v2: no addSpanProcessor — push directly into MultiSpanProcessor
    delegate._activeSpanProcessor._spanProcessors.push(new SimpleSpanProcessor(memExporter))
  }
  return memExporter
}

/**
 * Execute a request, flush spans, return finished spans.
 * @param {Function} fn - async function that makes the request
 * @returns {Promise<Array>} finished spans
 */
export async function getSpansAfterRequest(fn) {
  const exporter = await getSpanExporter()
  exporter.reset()
  await fn()
  const { trace } = await import("@opentelemetry/api")
  const provider = trace.getTracerProvider()
  const delegate = provider.getDelegate?.() || provider
  if (delegate.forceFlush) await delegate.forceFlush().catch(() => {})
  return exporter.getFinishedSpans()
}

/** Find first span matching a name pattern */
export function findSpan(spans, namePattern) {
  return spans.find((s) =>
    typeof namePattern === "string" ? s.name.includes(namePattern) : namePattern.test(s.name),
  )
}

/** Find all spans matching a name pattern */
export function findSpans(spans, namePattern) {
  return spans.filter((s) =>
    typeof namePattern === "string" ? s.name.includes(namePattern) : namePattern.test(s.name),
  )
}

/**
 * Create a sendMessageWithParts helper bound to a POST function.
 * @param {Function} POST - from cds.test()
 * @returns {Function} sendMessageWithParts(service, parts)
 */
export function createSendMessageWithParts(POST) {
  return function sendMessageWithParts(service, parts) {
    return POST(`/a2a/${service}/`, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts,
        },
      },
    })
  }
}

/**
 * Create a sendMessage helper bound to a POST function.
 * @param {Function} POST - from cds.test()
 * @returns {Function} sendMessage(service, text)
 */
export function createSendMessage(POST) {
  return function sendMessage(service, text, opts) {
    return POST(
      `/a2a/${service}/`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text }],
          },
        },
      },
      opts,
    )
  }
}
