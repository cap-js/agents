/**
 * Shared test utilities for telemetry integration tests.
 *
 * Usage:
 *   const { captured, setup, flushMetrics, getSpansAfterRequest, findSpan, findSpans } = require("./telemetry-utils")
 *   setup() // call BEFORE cds.test() to patch console.info early
 */
const cds = require("@sap/cds")

/** Captured console.info output */
const captured = []
const _originalInfo = console.info

/**
 * Patch console.info to capture telemetry output.
 * MUST be called BEFORE cds.test() so cds.log('telemetry') picks up the patched version.
 */
function setup() {
  console.info = function (...args) {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    captured.push(msg)
    _originalInfo.apply(console, args)
  }
}

/** Restore console.info — call in afterAll() */
function teardown() {
  console.info = _originalInfo
}

/** Reset captured output — call in beforeEach() */
function resetCapture() {
  captured.length = 0
}

/**
 * Flush metrics and return captured console output.
 * Uses forceFlush() as the sole synchronisation — no arbitrary timeouts.
 */
async function flushMetrics() {
  const { metrics } = require("@opentelemetry/api")
  const meterProvider = metrics.getMeterProvider()
  expect(typeof meterProvider.forceFlush).toBe("function")
  await meterProvider.forceFlush()
  return captured.join("")
}

/** In-memory span exporter — lazily initialized, shared per process */
let memExporter
function getSpanExporter() {
  if (memExporter) return memExporter
  const { trace } = require("@opentelemetry/api")
  const { SimpleSpanProcessor, InMemorySpanExporter } = require("@opentelemetry/sdk-trace-base")
  memExporter = new InMemorySpanExporter()
  const provider = trace.getTracerProvider()
  const delegate = provider.getDelegate?.() || provider
  if (delegate.addSpanProcessor) {
    delegate.addSpanProcessor(new SimpleSpanProcessor(memExporter))
  }
  return memExporter
}

/**
 * Execute a request, flush spans, return finished spans.
 * @param {Function} fn - async function that makes the request
 * @returns {Promise<Array>} finished spans
 */
async function getSpansAfterRequest(fn) {
  getSpanExporter().reset()
  await fn()
  const { trace } = require("@opentelemetry/api")
  const provider = trace.getTracerProvider()
  const delegate = provider.getDelegate?.() || provider
  if (delegate.forceFlush) await delegate.forceFlush()
  return getSpanExporter().getFinishedSpans()
}

/** Find first span matching a name pattern */
function findSpan(spans, namePattern) {
  return spans.find((s) =>
    typeof namePattern === "string" ? s.name.includes(namePattern) : namePattern.test(s.name),
  )
}

/** Find all spans matching a name pattern */
function findSpans(spans, namePattern) {
  return spans.filter((s) =>
    typeof namePattern === "string" ? s.name.includes(namePattern) : namePattern.test(s.name),
  )
}

/**
 * Create a sendMessage helper bound to a POST function.
 * @param {Function} POST - from cds.test()
 * @returns {Function} sendMessage(service, text)
 */
function createSendMessage(POST) {
  return function sendMessage(service, text) {
    return POST(`/a2a/${service}/`, {
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
    })
  }
}

module.exports = {
  captured,
  setup,
  teardown,
  resetCapture,
  flushMetrics,
  getSpanExporter,
  getSpansAfterRequest,
  findSpan,
  findSpans,
  createSendMessage,
}
