import cds from "@sap/cds"

const LOG = cds.log("agents")

export default async function buildMiddleware(srv, options = {}) {
  const { tools, model } = options
  const { quotaEnforcerMiddleware } = await import("./quota-enforcer.js")
  const { contentFilterMiddleware } = await import("./content-filter.js")
  const { agentActionsMiddleware } = await import("./agent-actions.js")
  const { patchToolCallsMiddleware } = await import("./patch-tool-calls.js")
  const { statusUpdateMiddleware } = await import("./status-update.js")
  const { humanInTheLoopMiddleware } = await import("./hitl.js")
  const { toolSelectionMiddleware } = await import("./tool-selection.js")
  return [
    ...(await quotaEnforcerMiddleware()),
    await contentFilterMiddleware(model),
    await agentActionsMiddleware(),
    patchToolCallsMiddleware(),
    await statusUpdateMiddleware(),
    ...(await humanInTheLoopMiddleware(srv, tools)),
    toolSelectionMiddleware(),
    LOG._debug ? (await import("./tool-debug.js")).toolDebugMiddleware() : null,
  ].filter(Boolean)
}

