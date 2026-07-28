export default async function buildMiddleware(srv, options = {}) {
  const { tools } = options
  const { quotaEnforcerMiddleware } = await import("./quota-enforcer.js")
  const { contentFilterMiddleware } = await import("./content-filter.js")
  const { agentActionsMiddleware } = await import("./agent-actions.js")
  const { statusUpdateMiddleware } = await import("./status-update.js")
  const { humanInTheLoopMiddleware } = await import("./hitl.js")
  return [
    ...(await quotaEnforcerMiddleware()),
    await contentFilterMiddleware(),
    await agentActionsMiddleware(),
    await statusUpdateMiddleware(),
    await humanInTheLoopMiddleware(srv, tools),
  ].filter(Boolean)
}
