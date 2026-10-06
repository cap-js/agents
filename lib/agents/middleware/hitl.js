import { humanInTheLoopMiddleware as hitl } from "langchain"
import { hitlDecisionNoteInjectorMiddleware } from "./hitl-decision-note-injector.js"

const ALLOWED_DECISIONS = ["approve", "reject", "edit"]

const isHitlAction = (action) => action?.["@agent.hitl"] ?? action?.["@Common.IsActionCritical"]

export function buildHitlInterruptMap(srv, tools = []) {
  return tools.reduce((interruptOn, tool) => {
    // Per-action tool: its name IS the action name, so a static entry gates it.
    if (isHitlAction(srv.actions[tool.name])) {
      interruptOn[tool.name] = { allowedDecisions: ALLOWED_DECISIONS }
    }
    // Generic @cap-js/mcp "call" tool: one tool fronts every action, with the
    // target action in args.action. The tool name matches no action, so gate
    // per-call via `when`, which inspects the requested action at invoke time.
    else if (tool.name === "call" && Object.values(srv.actions).some(isHitlAction)) {
      interruptOn[tool.name] = {
        allowedDecisions: ALLOWED_DECISIONS,
        when: (request) => Boolean(isHitlAction(srv.actions[request.toolCall?.args?.action])),
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
