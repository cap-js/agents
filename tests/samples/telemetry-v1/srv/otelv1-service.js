import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"

/**
 * Minimal agent service for OTEL v1 backward-compat telemetry tests.
 * Builds a simple graph that uses the CDS query tool.
 */
export default class OtelV1Service extends cds.ApplicationService {
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

    async function agentNode() {
      const queryTool = tools.find((t) => t.name === "query")
      if (!queryTool) {
        return { messages: [new AIMessage("No query tool.")], output: "No query tool." }
      }
      const result = await queryTool.invoke({ entity: "Books", limit: 3 })
      return { messages: [new AIMessage(result)], output: result }
    }

    const graph = new StateGraph(GraphState)
      .addNode("agent", agentNode)
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")

    return graph.compile()
  }
}
