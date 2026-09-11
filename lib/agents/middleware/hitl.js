import { humanInTheLoopMiddleware as hitl } from "langchain"
import { hitlDecisionNoteInjectorMiddleware } from "./hitl-decision-note-injector.js"

export function buildHitlInterruptMap(srv, tools = []) {
  return tools.reduce((interruptOn, tool) => {
    if (
      srv.actions[tool.name]?.["@agent.hitl"] ??
      srv.actions[tool.name]?.["@Common.IsActionCritical"]
    ) {
      interruptOn[tool.name] = {
        allowedDecisions: ["approve", "reject", "edit"],
        when: ({ toolCall, state }) => !state._hitlApprovedTools?.includes(toolCall.name),
      }
    }
    return interruptOn
  }, {})
}

export async function humanInTheLoopMiddleware(srv, tools) {
  const interruptOn = buildHitlInterruptMap(srv, tools)
  if (!Object.keys(interruptOn).length) return []
  return [hitl({ interruptOn }), hitlDecisionNoteInjectorMiddleware()]
}
