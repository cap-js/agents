import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"

const LOG = cds.log("agents")

/**
 * Streaming metrics/audit integration test service.
 * Uses InstrumentedOrchestrationClient (streaming: true) pointed at mock AI Core.
 *
 * This exercises the full streaming code path including:
 * - _streamResponseChunks with context.with() span nesting
 * - _handleLLMSuccess (metrics + audit)
 * - _handleLLMError (error metrics + content-filter detection)
 */
export default class StreamingMetricsService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      return this._buildGraph()
    })
    return super.init()
  }

  async _buildGraph() {
    const port = process.env.MOCK_AICORE_PORT
    if (!port) {
      LOG.warn("MOCK_AICORE_PORT not set — streaming metrics service will fail at runtime")
    }

    // Import InstrumentedOrchestrationClient using relative path (avoids .js.js resolution issue)
    const { default: InstrumentedOrchestrationClient } =
      await import("../../../../lib/models/aicore.js")

    const model = new InstrumentedOrchestrationClient("StreamingMetricsTestModel", {
      model: "mock-streaming-model",
      params: { temperature: 0, max_tokens: 100 },
      streaming: true,
      contentFilter: false,
      flatten: false,
    })
    // Wire to mock AI Core
    model.deploymentConfig = { deploymentId: "test-deployment" }
    model.destination = { url: `http://localhost:${port}` }

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
    })

    async function agentNode(state, config) {
      const response = await model.invoke(state.messages, config)
      return {
        messages: [response],
        output: response.content,
      }
    }

    const graph = new StateGraph(GraphState)
      .addNode("agent", agentNode)
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")

    return graph.compile()
  }
}
