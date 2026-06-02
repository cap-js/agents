import shouldContinue from "./shouldContinue.js"
import agent from "./agent.js"
import tool from "./tool.js"
import quotaEnforcerAtNode from "./quotaEnforcerAtNode.js"
import quotaEnforcerAtStart from "./quotaEnforcerAtStart.js"

export function createManagedAgentNodes(model, toolMap) {
  return {
    agentNode: agent(model),
    toolNode: tool(toolMap),
    shouldContinue,
    quotaEnforcerAtNode,
    quotaEnforcerAtStart,
  }
}
