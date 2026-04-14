async function createAgentGraph(agentState, nodes) {
  const { StateGraph, END } = await import("@langchain/langgraph")

  const workflow = new StateGraph(agentState)
  workflow.addNode("agent", nodes.agentNode)
  workflow.addNode("tools", nodes.toolNode)
  workflow.addEdge("__start__", "agent")
  workflow.addConditionalEdges("agent", nodes.shouldContinue, {
    tools: "tools",
    end: END,
  })
  workflow.addEdge("tools", "agent")

  return workflow.compile()
}

module.exports = { createAgentGraph }
