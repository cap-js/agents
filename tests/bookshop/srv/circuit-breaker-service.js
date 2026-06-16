import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { circuitBreaker, timeout } from "@sap-cloud-sdk/resilience"
import { generateTools } from "@cap-js/a2a"

const LOG = cds.log("a2a")

/**
 * Circuit breaker integration test service.
 *
 * Builds a LangGraph with an agent node that calls an OrchestrationClient
 * with circuitBreaker() + timeout() middleware — same as the production
 * InstrumentedOrchestrationClient in lib/llm.js — pointed at a mock AI Core.
 *
 * Uses `this.a2a = { graph }` to bypass the mock executor and test the
 * real end-to-end path: A2A message → graph → agent node → model.invoke()
 *   → circuitBreaker middleware → HTTP to mock server
 */
export default class CircuitBreakerService extends cds.ApplicationService {
  init() {
    this.a2a = { graph: this._buildGraph() }
    return super.init()
  }

  async _buildGraph() {
    const port = process.env.MOCK_AICORE_PORT
    if (!port) {
      LOG.warn("MOCK_AICORE_PORT not set — circuit breaker service will fail at runtime")
    }

    const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")

    /**
     * Subclass that injects resilience middleware — replicates the exact pattern
     * from lib/llm.js createInstrumentedClient() without telemetry.
     */
    class CircuitBreakerTestModel extends OrchestrationClient {
      async _generate(messages, opts, runManager) {
        const llmTimeout = cds.env.a2a?.pool?.maxLLMCallTimeoutMs || 120000
        opts = {
          ...opts,
          customRequestConfig: {
            ...opts?.customRequestConfig,
            middleware: [timeout(llmTimeout), circuitBreaker()],
          },
        }
        return super._generate(messages, opts, runManager)
      }
    }

    const model = new CircuitBreakerTestModel(
      { promptTemplating: { model: { name: "mock-model", params: {} } } },
      {
        maxRetries: 1, // reduced for test speed; still validates fix (1 retry would delay without it)
        onFailedAttempt: (err) => {
          // Same fix as lib/llm.js: abort retries when circuit breaker is open
          if (err.code === "EOPENBREAKER" || err.message === "Breaker is open") {
            throw err
          }
        },
      },
      { deploymentId: "test-deployment" },
      { url: `http://localhost:${port}` },
    )

    const GraphState = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer }),
      output: Annotation({ reducer: (_, v) => v }),
    })

    // Agent node: calls the real OrchestrationClient (with circuit breaker)
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
