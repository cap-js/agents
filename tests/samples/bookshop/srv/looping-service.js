import cds from "@sap/cds"

/**
 * Looping agent that always requests tool calls.
 * Used to test per-node quota enforcement (maxLLMInvocationsPerTask etc.)
 * via the quotaEnforcerMiddleware (afterModel hook).
 *
 * Uses langchain's createAgent with a mock model that always returns tool_calls,
 * forcing the agent loop until middleware stops it.
 */
export default class LoopingService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      return this._buildGraph()
    })
    return super.init()
  }

  async _buildGraph() {
    const srv = this
    const { createAgent } = await import("langchain")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage } = await import("@langchain/core/messages")

    const tools = await srv.send("buildTools")
    const middleware = await srv.send("buildMiddleware")

    // Mock model that always returns a tool call (forces looping)
    let iteration = 0
    class LoopingModel extends BaseChatModel {
      _llmType() {
        return "looping-mock"
      }
      bindTools() {
        return this
      }
      async _generate() {
        iteration++
        const msg = new AIMessage({
          content: `Iteration ${iteration}`,
          tool_calls: [{ name: "query", args: { entity: "Books" }, id: `call-${iteration}` }],
          usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
        })
        return { generations: [{ message: msg }] }
      }
    }

    const model = new LoopingModel({})

    return createAgent({
      model,
      tools,
      middleware,
    })
  }
}
