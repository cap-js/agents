import cds from "@sap/cds"
import { humanInTheLoopMiddleware as hitl } from "langchain"
import { hitlDecisionNoteInjectorMiddleware } from "./hitl-decision-note-injector.js"
import { toolName } from "../../utils/utils.js"

const ALLOWED_DECISIONS = ["approve", "reject", "edit"]

const isHitlAction = (action) => action?.["@agent.hitl"] ?? action?.["@Common.IsActionCritical"]

export function buildHitlInterruptMap(srv, tools = []) {
  return tools.reduce((interruptOn, tool) => {
    const serviceName = tool.serviceName ?? tool.metadata?.serviceName
    const target = serviceName ? cds.services?.[serviceName] : srv
    const actions = target?.actions
    if (!actions) return interruptOn

    if (tool._mcpDynamic) {
      const additional = buildHitlInterruptMap(
        target,
        [...Object.keys(actions), "call"].map((name) => ({
          name: toolName(`${serviceName}_${name}`),
          serviceName,
        })),
      )
      Object.assign(interruptOn, additional)
      return interruptOn
    }
    // Tools from other services are prefixed with the service name
    const name = serviceName ? tool.name.slice(toolName(`${serviceName}_`).length) : tool.name
    // Per-action tool: its name IS the action name, so a static entry gates it.
    if (isHitlAction(actions[name])) {
      interruptOn[tool.name] = { allowedDecisions: ALLOWED_DECISIONS }
    }
    // Generic @cap-js/mcp "call" tool: one tool fronts every action, with the
    // target action in args.action. The tool name matches no action, so gate
    // per-call via `when`, which inspects the requested action at invoke time.
    else if (name === "call" && Object.values(actions).some(isHitlAction)) {
      interruptOn[tool.name] = {
        allowedDecisions: ALLOWED_DECISIONS,
        when: (request) => Boolean(isHitlAction(actions[request.toolCall?.args?.action])),
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
