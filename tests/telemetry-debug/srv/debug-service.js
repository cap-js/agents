const cds = require("@sap/cds")
const { StateGraph, Annotation, messagesStateReducer } = require("@langchain/langgraph")
const { AIMessage } = require("@langchain/core/messages")
const { generateTools } = require("@cap-js/a2a")

/**
 * Service with two modes:
 * - "fail" in message → graph throws (tests a2a.errors.total + failed span)
 * - anything else → normal query (tests debug content capture on tool spans)
 */
module.exports = class DebugService extends cds.ApplicationService {
  init() {
    this.a2a = { graph: this._buildGraph() }
    return super.init()
  }

  async _buildGraph() {
    const srv = this
    const { tools } = generateTools(srv, { skipAuth: true })

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
    })

    async function agentNode(state) {
      // Check if user message contains "fail" — simulate error
      const lastMsg = state.messages[state.messages.length - 1]
      const text = typeof lastMsg?.content === "string" ? lastMsg.content : ""
      if (text.toLowerCase().includes("fail")) {
        throw new Error("Simulated graph failure for testing")
      }

      // Normal path: query books via MCP tool
      const queryTool = tools.find((t) => t.name === "query")
      if (!queryTool) {
        return { messages: [new AIMessage("No query tool.")], output: "No query tool." }
      }
      const result = await queryTool.invoke({ entity: "Books", limit: 2 })
      return { messages: [new AIMessage(result)], output: result }
    }

    const graph = new StateGraph(GraphState)
      .addNode("agent", agentNode)
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")

    return graph.compile()
  }
}
