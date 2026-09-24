import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"

/**
 * Service with two modes:
 * - "fail" in message → graph throws (tests agent.errors.total + failed span)
 * - anything else → normal query (tests debug content capture on tool spans)
 */
export default class DebugService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      return this._buildGraph()
    })
    return super.init()
  }

  async _buildGraph() {
    const srv = this
    const tools = await srv.send("buildTools")

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
      const result = await queryTool.invoke({ cql: "SELECT * FROM Books LIMIT 2" })
      return { messages: [new AIMessage(result)], output: result }
    }

    const graph = new StateGraph(GraphState)
      .addNode("agent", agentNode)
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")

    return graph.compile()
  }
}
