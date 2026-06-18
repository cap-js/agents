import cds from "@sap/cds"
import LangGraphExecutorService from "./langgraph-executor-srv.js"
import { GraphExecutor } from "./handlers/graph-executor.js"

/**
 * Mock Executor Service.
 * Extends LangGraphExecutorService. If app registered a custom buildGraph handler,
 * dispatches it. Otherwise builds a deterministic mock graph (no LLM) that queries
 * the first entity via instrumented tools and responds with the data.
 */
export default class MockExecutorService extends LangGraphExecutorService {
  async init() {
    return super.init()
  }

  async _buildExecutor(srv) {
    const handlers = srv._handlers?.on?.filter((h) => h.on === "buildGraph") || []
    if (handlers.length > 1) {
      try {
        return await super._buildExecutor(srv)
      } catch {
        // fall back to mock
      }
    }

    const { generateTools, instrumentTools } = await import("./handlers/tools.js")
    const tools = generateTools(srv, { skipAuth: true })
    if (tools.length > 0) instrumentTools(tools)

    const graph = await this._buildMockGraph(srv, tools)
    return new GraphExecutor(graph, srv)
  }

  async _buildMockGraph(srv, tools) {
    const { StateGraph, Annotation, messagesStateReducer } = await import("@langchain/langgraph")
    const { AIMessage } = await import("@langchain/core/messages")
    const { getFilteredEntities } = await import("../lib/utils/utils.js")

    const queryTool = tools?.find((t) => t.name === "query")
    const entities = Object.keys(getFilteredEntities(srv))

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
    })

    async function agentNode(state) {
      let data = "No data found."
      if (queryTool && entities.length > 0) {
        try {
          data = await queryTool.invoke({ entity: entities[0], limit: 3 })
        } catch {
          data = "Could not query data from the service."
        }
      }
      return { messages: [new AIMessage(data)], output: data }
    }

    return new StateGraph(GraphState)
      .addNode("agent", agentNode)
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")
      .compile()
  }
}
