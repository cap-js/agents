/**
 * Test-time tool call recorder.
 *
 * Patches `StructuredTool.prototype.invoke` with a lightweight observer that
 * fans every invocation out to each recorder currently in `activeRecorders`.
 * When the Set is empty, the patch is effectively a no-op.
 *
 * Recorders are scoped to a single operation (typically a `runAgent()` call):
 * the caller adds a recorder before the operation, disposes it on `finally`.
 * Between operations no state is retained.
 *
 * Independent from the tracing patch in `lib/telemetry/tracing.js`: both
 * wrappers can co-exist (each delegates to the previous `invoke`), and use
 * distinct symbols so telemetry can still patch on top.
 */

const RECORDER_PATCHED = Symbol.for("@cap-js/agents:testing:tool-recorder-patched")

const activeRecorders = new Set()

function record(entry) {
  if (activeRecorders.size === 0) return
  for (const r of activeRecorders) {
    try {
      r(entry)
    } catch {
      /* never throw from the recorder */
    }
  }
}

/**
 * Register a recorder for the duration of an operation.
 * Returns a dispose function that removes the recorder.
 */
export function addRecorder(fn) {
  activeRecorders.add(fn)
  return () => activeRecorders.delete(fn)
}

function _patchProto(proto) {
  if (!proto || proto[RECORDER_PATCHED]) return
  const original = proto.invoke
  if (typeof original !== "function") return

  proto.invoke = async function (args, config) {
    const t0 = Date.now()
    const name = this.name || this.constructor?.name || "tool"
    // LangGraph often calls tools with the full ToolCall envelope
    // `{ name, args, id, type: "tool_call" }` instead of raw arguments.
    // Unwrap so assertions match what the model actually produced.
    const effectiveArgs =
      args && typeof args === "object" && args.type === "tool_call" && "args" in args
        ? args.args
        : args
    try {
      const result = await original.call(this, args, config)
      record({
        tool: name,
        args: effectiveArgs,
        outcome: "success",
        result,
        duration: Date.now() - t0,
      })
      return result
    } catch (err) {
      record({
        tool: name,
        args: effectiveArgs,
        outcome: "error",
        error: err?.message,
        duration: Date.now() - t0,
      })
      throw err
    }
  }
  Object.defineProperty(proto, RECORDER_PATCHED, { value: true, enumerable: false })
}

let _patchOnce
/**
 * Patch `StructuredTool.prototype.invoke` once so tool calls fan out to
 * every active recorder. Idempotent; safe to call multiple times.
 * Silently no-ops if `@langchain/core/tools` is not resolvable.
 */
export function ensureToolRecordingPatch() {
  if (_patchOnce) return _patchOnce
  _patchOnce = (async () => {
    try {
      const mod = await import("@langchain/core/tools")
      _patchProto(mod.StructuredTool?.prototype)
    } catch {
      /* langchain not present — nothing to patch */
    }
  })()
  return _patchOnce
}
