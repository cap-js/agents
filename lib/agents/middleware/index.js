export default async function buildMiddleware(srv, options = {}) {
  const { tools, model } = options
  const { masking } = await import("./masking.js")
  const { quotaEnforcerMiddleware } = await import("./quota-enforcer.js")
  const { contentFilterMiddleware } = await import("./content-filter.js")
  const { agentActionsMiddleware } = await import("./agent-actions.js")
  const { patchToolCallsMiddleware } = await import("./patch-tool-calls.js")
  const { statusUpdateMiddleware } = await import("./status-update.js")
  const { humanInTheLoopMiddleware } = await import("./hitl.js")
  const { toolSelectionMiddleware } = await import("./tool-selection.js")
  const { toolWrapMiddleware } = await import("./tool-wrap.js")

  const hasDynamic = tools?.some((t) => t._dynamicTools) ?? false
  let dynamicMiddlewares = []
  if (hasDynamic) {
    const { dynamicToolsMiddleware } = await import("./dynamic-tools.js")
    dynamicMiddlewares = [dynamicToolsMiddleware()]
  }

  return [
    ...dynamicMiddlewares,
    masking(srv), // first — all downstream middleware see pseudonymized data
    ...(await quotaEnforcerMiddleware()),
    await contentFilterMiddleware(model),
    await agentActionsMiddleware(),
    patchToolCallsMiddleware(),
    await statusUpdateMiddleware(tools),
    ...(await humanInTheLoopMiddleware(srv, tools)),
    toolSelectionMiddleware(),
    toolWrapMiddleware(srv),
  ].filter(Boolean)
}
