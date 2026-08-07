import { humanInTheLoopMiddleware as hitl } from "langchain"

function buildHitlInterruptMap(srv, tools = []) {
  return tools.reduce((interruptOn, tool) => {
    if (
      srv.actions[tool.name]?.["@agent.hitl"] ??
      srv.actions[tool.name]?.["@Common.IsActionCritical"]
    ) {
      interruptOn[tool.name] = { allowedDecisions: ["approve", "reject", "edit"] }
    }
    return interruptOn
  }, {})
}

export async function humanInTheLoopMiddleware(srv, tools) {
  const interruptOn = buildHitlInterruptMap(srv, tools)
  return Object.keys(interruptOn).length && hitl({ interruptOn })
}
