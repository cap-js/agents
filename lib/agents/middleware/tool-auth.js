import { createMiddleware } from "langchain"

/**
 * Middleware that filters the tool list passed to the model on every call.
 * The graph is cached once with all tools; this middleware trims it to the
 * subset the current user is authorized to see (checkAuthorization runs per-request).
 *
 * Tools with an isAllowed() method (GenericReadTool, DescribeTool, etc.) are dropped
 * when the method returns false. Their description and schema getters return
 * auth-filtered content dynamically, so the model always sees only what the user
 * can access — no new instances, no renamed tools.
 */
export function toolAuthMiddleware() {
  return createMiddleware({
    name: "ToolAuthMiddleware",
    wrapModelCall: (request, handler) => {
      if (!request.tools?.length) return handler(request)
      const tools = request.tools.filter((t) => t.isAllowed ? t.isAllowed() : true)
      return handler({ ...request, tools })
    },
  })
}
