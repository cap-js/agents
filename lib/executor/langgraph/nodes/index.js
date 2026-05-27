const shouldContinue = require("./shouldContinue")
const agent = require("./agent")
const tool = require("./tool")
const quotaEnforcerAtNode = require("./quotaEnforcerAtNode")
const quotaEnforcerAtStart = require("./quotaEnforcerAtStart")

function createManagedAgentNodes(model, toolMap) {
  return {
    agentNode: agent(model),
    toolNode: tool(toolMap),
    shouldContinue,
    quotaEnforcerAtNode,
    quotaEnforcerAtStart,
  }
}

module.exports = { createManagedAgentNodes }
