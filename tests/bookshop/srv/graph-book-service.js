const cds = require("@sap/cds")
const { StateGraph, Annotation, messagesStateReducer } = require("@langchain/langgraph")
const { AIMessage } = require("@langchain/core/messages")
const { generateTools } = require("@cap-js/a2a")
const metrics = require("@cap-js/a2a/lib/telemetry/metrics")

/**
 * Deterministic graph-based agent for telemetry e2e testing.
 * Uses @cap-js/mcp tools (via generateTools) + mock LLM metrics.
 */
module.exports = class GraphBookService extends cds.ApplicationService {
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

    // Mock LLM node: simulates an LLM call with token usage metrics
    async function llmNode(state) {
      const modelName = "mock-model-for-testing"
      const node = "llm"
      const mAttrs = { "sap.tenantId": cds.context?.tenant || "anonymous", model: modelName, node }

      const usage = { input_tokens: 42, output_tokens: 18, total_tokens: 60 }
      metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
      metrics.llmInputTokens.add(usage.input_tokens, mAttrs)
      metrics.llmOutputTokens.add(usage.output_tokens, mAttrs)

      return {
        messages: [
          new AIMessage({ content: "I will query books for you.", usage_metadata: usage }),
        ],
      }
    }

    // Tool node: invoke the MCP-generated query tool
    async function toolNode(state) {
      const queryTool = tools.find((t) => t.name === "query")
      if (!queryTool) {
        return {
          messages: [new AIMessage("No query tool available.")],
          output: "No query tool available.",
        }
      }
      const result = await queryTool.invoke({ entity: "Books", limit: 3 })
      return { messages: [new AIMessage(result)], output: result }
    }

    const graph = new StateGraph(GraphState)
      .addNode("llm", llmNode)
      .addNode("tools", toolNode)
      .addEdge("__start__", "llm")
      .addEdge("llm", "tools")
      .addEdge("tools", "__end__")

    return graph.compile()
  }
}
