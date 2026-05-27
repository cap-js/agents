const cds = require("@sap/cds")
const { StateGraph, Annotation, messagesStateReducer, END } = require("@langchain/langgraph")
const { AIMessage } = require("@langchain/core/messages")
const { generateTools } = require("@cap-js/a2a")

/**
 * Looping graph that iterates multiple times.
 * Used to test per-node quota enforcement (maxLLMInvocationsPerTask etc.)
 * The graph simulates an agent that always wants to call tools,
 * triggering shouldContinue → quotaEnforcerAtNode on each iteration.
 */
module.exports = class LoopingService extends cds.ApplicationService {
  init() {
    this.a2a = { graph: this._buildGraph() }
    return super.init()
  }

  async _buildGraph() {
    const srv = this
    const { tools } = generateTools(srv, { skipAuth: true })
    const shouldContinue = require("@cap-js/a2a/lib/executor/langgraph/nodes/shouldContinue")

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
        _totalToolCalls: state._totalToolCalls + 1,
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
