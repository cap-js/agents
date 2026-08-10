import cds from "@sap/cds"

/**
 * Looping agent that always emits SQL-format query tool calls.
 * Used to test status-update middleware label resolution when query uses sql format.
 */
export default class LoopingSqlService extends cds.ApplicationService {
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

    // Mock model that always returns a SQL-format query tool call (forces looping)
    let iteration = 0
    class LoopingSqlModel extends BaseChatModel {
      _llmType() {
        return "looping-sql-mock"
      }
      bindTools() {
        return this
      }
      async _generate() {
        iteration++
        const msg = new AIMessage({
          content: `Iteration ${iteration}`,
          tool_calls: [
            {
              name: "query",
              args: { cql: "SELECT * FROM LoopingSqlService.Books" },
              id: `call-${iteration}`,
            },
          ],
          usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
        })
        return { generations: [{ message: msg }] }
      }
    }

    const model = new LoopingSqlModel({})

    return createAgent({
      model,
      tools,
      middleware,
    })
  }
}
