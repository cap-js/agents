/**
 * Wires the ReAct agent graph:
 *
 *   START → agent → shouldContinue → tools → agent (loop)
 *                                  ↘ END
 *
 * Checkpointer enables multi-turn: state persisted between graph.invoke() calls
 * on the same thread_id (= A2A contextId).
 */
async function createAgentGraph(agentState, nodes, checkpointer) {
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

  return workflow.compile({ checkpointer })
}

module.exports = { createAgentGraph }
