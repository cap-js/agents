export default async function buildMiddleware(srv, options = {}) {
  const { tools, model } = options
  const { quotaEnforcerMiddleware } = await import("./quota-enforcer.js")
  const { contentFilterMiddleware } = await import("./content-filter.js")
  const { agentActionsMiddleware } = await import("./agent-actions.js")
  const { patchToolCallsMiddleware } = await import("./patch-tool-calls.js")
  const { statusUpdateMiddleware } = await import("./status-update.js")
  const { humanInTheLoopMiddleware } = await import("./hitl.js")
  const { toolSelectionMiddleware } = await import("./tool-selection.js")

  const dynamicMcpPlaceholders = tools?.filter((t) => t._mcpDynamic) ?? []
  let dynamicMcpMiddlewares = []
  if (dynamicMcpPlaceholders.length) {
    const { remoteMcpMiddleware } = await import("./remote-mcp.js")
    dynamicMcpMiddlewares = dynamicMcpPlaceholders.map((p) => remoteMcpMiddleware(p))
  }

  return [
    ...dynamicMcpMiddlewares,
    ...(await quotaEnforcerMiddleware()),
    await contentFilterMiddleware(model),
    await agentActionsMiddleware(),
    patchToolCallsMiddleware(),
    await statusUpdateMiddleware(),
    ...(await humanInTheLoopMiddleware(srv, tools)),
    toolSelectionMiddleware(),
  ].filter(Boolean)
}
