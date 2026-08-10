import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { circuitBreaker, timeout } from "@sap-cloud-sdk/resilience"
import { ms4 } from "../../../../lib/utils/utils.js"

const LOG = cds.log("agent")

/**
 * Circuit breaker integration test service.
 *
 * Builds a LangGraph with an agent node that calls an OrchestrationClient
 * with circuitBreaker() + timeout() middleware — same as the production
 * InstrumentedOrchestrationClient in lib/llm.js — pointed at a mock AI Core.
 *
 * Uses `this.agent = { graph }` to bypass the mock executor and test the
 * real end-to-end path: A2A message → graph → agent node → model.invoke()
 *   → circuitBreaker middleware → HTTP to mock server
 */
export default class CircuitBreakerService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      return this._buildGraph()
    })
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
     * Both _generate and _streamResponseChunks are overridden so the circuit
     * breaker middleware is applied regardless of which path is used.
     */
    class CircuitBreakerTestModel extends OrchestrationClient {
      _withMiddleware(opts) {
        const llmTimeout = ms4(cds.env.agents?.pool?.maxLLMCallTimeout || "120s")
        return {
          ...opts,
          customRequestConfig: {
            ...opts?.customRequestConfig,
            middleware: [timeout(llmTimeout), circuitBreaker()],
          },
        }
      }

      async _generate(messages, opts, runManager) {
        return super._generate(messages, this._withMiddleware(opts), runManager)
      }

      async *_streamResponseChunks(messages, opts, runManager) {
        yield* super._streamResponseChunks(messages, this._withMiddleware(opts), runManager)
      }
    }

    const model = new CircuitBreakerTestModel(
      { promptTemplating: { model: { name: "mock-model", params: {} } } },
      {
        // streaming:false keeps the blocking _generate() path because the mock AI Core
        // only serves non-streaming JSON responses (no SSE endpoint).
        // The _streamResponseChunks override above ensures the middleware is wired
        // correctly for both paths in production.
        streaming: false,
        maxRetries: 0, // no retries — each 502 fails immediately with no backoff delay
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
