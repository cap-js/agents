/**
 * Test-time tool call recorder + per-scope mocking.
 *
 * Patches `StructuredTool.prototype.invoke` with a lightweight observer that
 * fans every invocation out to each scope currently in `activeScopes`.
 *
 * Each scope carries:
 *   - `record`: fn that receives an entry `{ tool, args, outcome, result?, error?,
 *               duration, mocked? }` for logging into the scope's toolCalls array.
 *   - `mocks`:  optional `{ [toolName]: async (args) => result }` map. If a
 *               scope mocks the tool being invoked, the mock runs and its
 *               result is returned to LangChain WITHOUT calling the real tool.
 *
 * Between operations the Set is empty and the patch is effectively a no-op.
 *
 * Independent from the tracing patch in `lib/telemetry/tracing.js`: both
 * wrappers can co-exist (each delegates to the previous `invoke`) and use
 * distinct symbols so telemetry can still patch on top.
 */

const RECORDER_PATCHED = Symbol.for("@cap-js/agents:testing:tool-recorder-patched")

const activeScopes = new Set()

function recordFor(scope, entry) {
  try {
    scope.record(entry)
  } catch {
    /* never throw from the recorder */
  }
}

/**
 * Register a scope for the duration of an operation.
 *
 * @param {(entry: object) => void} record  Called for each tool invocation
 *                                          that happens while the scope is
 *                                          active.
 * @param {Record<string, Function>|null} mocks  Optional tool-name→handler
 *                                          map. Mocked tools short-circuit
 *                                          the real implementation.
 * @returns {() => void} dispose function that removes the scope.
 */
export function addScope(record, mocks = null) {
  const scope = { record, mocks }
  activeScopes.add(scope)
  return () => activeScopes.delete(scope)
}

function findMockFor(toolName) {
  if (activeScopes.size === 0) return null
  for (const scope of activeScopes) {
    if (scope.mocks && Object.prototype.hasOwnProperty.call(scope.mocks, toolName)) {
      return { scope, handler: scope.mocks[toolName] }
    }
  }
  return null
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
    // Unwrap so mocks and assertions receive what the model produced.
    const effectiveArgs =
      args && typeof args === "object" && args.type === "tool_call" && "args" in args
        ? args.args
        : args

    // Mock short-circuit: if any active scope mocks this tool, invoke the mock
    // and return without calling the real tool. Record on ALL active scopes
    // so assertions in the initiating scope see the call.
    const mock = findMockFor(name)
    if (mock) {
      try {
        const result = await mock.handler(effectiveArgs, this)
        const entry = {
          tool: name,
          args: effectiveArgs,
          outcome: "success",
          result,
          mocked: true,
          duration: Date.now() - t0,
        }
        for (const s of activeScopes) recordFor(s, entry)
        return result
      } catch (err) {
        const entry = {
          tool: name,
          args: effectiveArgs,
          outcome: "error",
          error: err?.message,
          mocked: true,
          duration: Date.now() - t0,
        }
        for (const s of activeScopes) recordFor(s, entry)
        throw err
      }
    }

    // No mock — run the real tool.
    try {
      const result = await original.call(this, args, config)
      const entry = {
        tool: name,
        args: effectiveArgs,
        outcome: "success",
        result,
        duration: Date.now() - t0,
      }
      for (const s of activeScopes) recordFor(s, entry)
      return result
    } catch (err) {
      const entry = {
        tool: name,
        args: effectiveArgs,
        outcome: "error",
        error: err?.message,
        duration: Date.now() - t0,
      }
      for (const s of activeScopes) recordFor(s, entry)
      throw err
    }
  }
  Object.defineProperty(proto, RECORDER_PATCHED, { value: true, enumerable: false })
}

let _patchOnce
/**
 * Patch `StructuredTool.prototype.invoke` once so tool calls fan out to
 * every active scope. Idempotent; safe to call multiple times. Silently
 * no-ops if `@langchain/core/tools` is not resolvable.
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
