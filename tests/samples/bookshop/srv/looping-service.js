import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer, END } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"

/**
 * Looping graph that iterates multiple times.
 * Used to test per-node quota enforcement (maxLLMInvocationsPerTask etc.)
 * The graph simulates an agent that always wants to call tools,
 * triggering shouldContinue → quotaEnforcerAtNode on each iteration.
 */
export default class LoopingService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      return this._buildGraph()
    })
    return super.init()
  }

  async _buildGraph() {
    const srv = this
    const tools = await srv.send("buildTools")
    const { default: shouldContinue } =
      await import("@cap-js/agents/lib/agents/react/nodes/shouldContinue.js")

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
      toolCalls: Annotation({ reducer: (_, v) => v, default: () => [] }),
      _iterations: Annotation({ reducer: (_, v) => v, default: () => 0 }),
      _totalTokens: Annotation({ reducer: (_, v) => v, default: () => 0 }),
      _totalToolCalls: Annotation({ reducer: (_, v) => v, default: () => 0 }),
    })

    // Agent node: always produces a tool call (forces looping)
    async function agentNode(state) {
      const iteration = state._iterations + 1
      return {
        messages: [
          new AIMessage({
            content: `Iteration ${iteration}`,
            tool_calls: [{ name: "query", args: { entity: "Books" }, id: `call-${iteration}` }],
          }),
        ],
        toolCalls: [{ name: "query", args: { entity: "Books" }, id: `call-${iteration}` }],
        _iterations: iteration,
        _totalTokens: state._totalTokens + 100,
        _totalToolCalls: 1,
      }
    }

    // Tool node: invoke the query tool
    async function toolNode(state) {
      const queryTool = tools.find((t) => t.name === "query")
      if (!queryTool) return { messages: [new AIMessage("No tool.")], output: "No tool." }
      const result = await queryTool.invoke({ entity: "Books", limit: 1 })
      return { messages: [new AIMessage(result)], output: result }
    }

    const graph = new StateGraph(GraphState)
      .addNode("agent", agentNode)
      .addNode("tools", toolNode)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue, { tools: "tools", end: END })
      .addEdge("tools", "agent")

    return graph.compile()
  }
}
