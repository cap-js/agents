import cds from "@sap/cds"
import { StateGraph, Annotation, messagesStateReducer } from "@langchain/langgraph"
import { AIMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import * as metrics from "@cap-js/agents/lib/telemetry/metrics.js"

/**
 * Custom tool (not CDS-generated) to verify prototype-level tracing covers it.
 */
const getBookCount = tool(
  async ({ genre_ID }) => {
    const { Books } = cds.model.entities("sap.capire.bookshop")
    const where = genre_ID ? { genre_ID } : {}
    const result = await SELECT.from(Books).where(where)
    return JSON.stringify({ count: result.length, genre_ID: genre_ID || "all" })
  },
  {
    name: "getBookCount",
    description: "Returns the number of books, optionally filtered by genre ID.",
    schema: z.object({
      genre_ID: z.number().optional().describe("Genre ID to filter by"),
    }),
  },
)

/**
 * Deterministic graph-based agent for telemetry e2e testing.
 * Uses @cap-js/mcp tools (via buildTools) + mock LLM metrics + custom tool.
 */
export default class GraphBookService extends cds.ApplicationService {
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

    // Mock LLM node: simulates an LLM call with token usage metrics
    async function llmNode(state) {
      const modelName = "mock-model-for-testing"
      const node = "llm"
      const mAttrs = { "sap.tenantId": cds.context?.tenant || "anonymous", model: modelName, node }

      const usage = { input_tokens: 42, output_tokens: 18, total_tokens: 60 }
      metrics.llmInvocations.add(1, { ...mAttrs, outcome: "success" })
      metrics.llmInputTokens.add(usage.input_tokens, mAttrs)
      metrics.llmOutputTokens.add(usage.output_tokens, mAttrs)
      metrics.agentActions.add(1, { "sap.tenantId": mAttrs["sap.tenantId"] })

      return {
        messages: [
          new AIMessage({ content: "I will query books for you.", usage_metadata: usage }),
        ],
      }
    }

    // Tool node: invoke both the CDS query tool and the custom getBookCount tool
    async function toolNode(state, config) {
      const queryTool = tools.find((t) => t.name === "query")
      if (!queryTool) {
        return {
          messages: [new AIMessage("No query tool available.")],
          output: "No query tool available.",
        }
      }
      const result = await queryTool.invoke({ entity: "Books", limit: 3 }, config)
      const countResult = await getBookCount.invoke({ genre_ID: 11 }, config)
      const output = `${result}\n\nBook count: ${countResult}`
      return { messages: [new AIMessage(output)], output }
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
