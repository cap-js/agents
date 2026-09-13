import cds from "@sap/cds"

export default class PseudoBookService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => this._buildGraph())
    return super.init()
  }

  async _buildGraph() {
    const srv = this
    const { createAgent } = await import("langchain")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage } = await import("@langchain/core/messages")

    const tools = await srv.send("buildTools")
    const middleware = await srv.send("buildMiddleware")

    class PseudoMockModel extends BaseChatModel {
      _llmType() {
        return "pseudo-mock"
      }
      bindTools() {
        return this
      }
      async _generate(messages) {
        const toolMsg = [...messages].reverse().find((m) => (m._getType?.() ?? m.type) === "tool")

        if (!toolMsg) {
          return {
            generations: [
              {
                message: new AIMessage({
                  content: "Looking up the author.",
                  tool_calls: [
                    {
                      name: "query",
                      args: { cql: "SELECT ID, name FROM PseudoBookService.Authors" },
                      id: "call-1",
                    },
                  ],
                  usage_metadata: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
                }),
              },
            ],
          }
        }

        const content = typeof toolMsg.content === "string" ? toolMsg.content : ""
        const hashes = [...content.matchAll(/name_[0-9a-f]{8}/g)].map((m) => m[0])
        const answer = hashes.length
          ? `The authors are: ${hashes.join(", ")}.`
          : "No authors found."
        return {
          generations: [
            {
              message: new AIMessage({
                content: answer,
                usage_metadata: { input_tokens: 30, output_tokens: 15, total_tokens: 45 },
              }),
            },
          ],
        }
      }
    }

    return createAgent({
      model: new PseudoMockModel({}),
      tools,
      middleware,
    })
  }
}
