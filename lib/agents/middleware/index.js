export default async function buildMiddleware(srv, options = {}) {
  const { tools, model } = options
  const { masking } = await import("./masking.js")
  const { quotaEnforcerMiddleware } = await import("./quota-enforcer.js")
  const { agentActionsMiddleware } = await import("./agent-actions.js")
  const { patchToolCallsMiddleware } = await import("./patch-tool-calls.js")
  const { statusUpdateMiddleware } = await import("./status-update.js")
  const { humanInTheLoopMiddleware } = await import("./hitl.js")
  const { toolSelectionMiddleware } = await import("./tool-selection.js")
  const { toolWrapMiddleware } = await import("./tool-wrap.js")
  const { contentFilterMiddleware } = await import("./content-filter.js")

  const hasDynamicMcp = tools?.some((t) => t._mcpDynamic) ?? false
  let dynamicMcpMiddlewares = []
  if (hasDynamicMcp) {
    const { remoteMcpMiddleware } = await import("./remote-mcp.js")
    dynamicMcpMiddlewares = [remoteMcpMiddleware()]
  }

  return [
    ...dynamicMcpMiddlewares,
    masking(srv), // first — all downstream middleware see pseudonymized data
    ...(await quotaEnforcerMiddleware()),
    await agentActionsMiddleware(),
    patchToolCallsMiddleware(),
    await statusUpdateMiddleware(tools),
    ...(await humanInTheLoopMiddleware(srv, tools)),
    toolSelectionMiddleware(),
    toolWrapMiddleware(srv),
    // Innermost model wrapper; its afterModel hook resumes filtered tool input first.
    contentFilterMiddleware(model),
  ].filter(Boolean)
}
