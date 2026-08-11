import { createMiddleware } from "langchain"

// Maps a request's configurable object (by identity) to the variant tool map
// produced by wrapModelCall, so wrapToolCall can resolve "mod_*" tool names.
const pendingVariants = new WeakMap()

/**
 * Middleware that filters the tool list passed to the model on every call.
 * The graph is cached once with all tools; this middleware trims it to the
 * subset the current user is authorized to see (checkAuthorization runs per-request).
 *
 * Tools with a .filtered() method (GenericReadTool, DescribeTool, etc.) may return:
 *   - this          → same instance, no change needed, keep as-is
 *   - a new instance with a "mod_" prefix name → auth-filtered variant
 *   - false/null    → user has no access, drop the tool
 *
 * LangChain forbids replacing a registered tool with a different instance of the
 * same name, but allows adding a tool with a new name when wrapToolCall is provided.
 * So filtered variants use a "mod_" prefix; wrapToolCall resolves them at execution time.
 */
export function toolAuthMiddleware() {
  return createMiddleware({
    name: "ToolAuthMiddleware",

    wrapModelCall: (request, handler) => {
      if (!request.tools?.length) return handler(request)

      const variants = new Map()
      const tools = []

      for (const t of request.tools) {
        if (!t.filtered) {
          tools.push(t)
          continue
        }
        const result = t.filtered()
        if (!result) continue          // no access — drop
        if (result === t) {
          tools.push(t)                // same instance — keep unchanged
        } else {
          tools.push(result)           // new name (mod_*) — add as new tool
          variants.set(result.name, result)
        }
      }

      // Stash variants so wrapToolCall can find them for this request
      if (variants.size > 0) pendingVariants.set(request.runtime.configurable, variants)

      return handler({ ...request, tools })
    },

    wrapToolCall: (request, handler) => {
      const variants = pendingVariants.get(request.runtime.configurable)
      const impl = variants?.get(request.toolCall.name)
      if (impl) return handler({ ...request, tool: impl })
      return handler(request)
    },
  })
}
