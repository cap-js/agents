import cds from "@sap/cds"

export default class StatusUpdateService extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => this._buildGraph())
    this.on(
      [
        "textFirst",
        "textLast",
        "textOnly",
        "textSeparate",
        "textPath",
        "noText",
        "plain",
        "externalDirect",
        "externalDirectXpr",
        "externalPath",
        "externalPathXpr",
      ],
      async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return req.data.book ?? req.data.value
      },
    )
    return super.init()
  }

  async _buildGraph() {
    const { createAgent } = await import("langchain")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")
    const tools = await this.send("buildTools")
    const middleware = await this.send("buildMiddleware", { tools })

    class StatusUpdateModel extends BaseChatModel {
      _llmType() {
        return "status-update-mock"
      }
      bindTools() {
        return this
      }
      async _generate(messages) {
        if (messages.some((m) => (m._getType?.() ?? m.type) === "tool")) {
          return { generations: [{ message: new AIMessage({ content: "Done" }) }] }
        }
        const human = [...messages].reverse().find(HumanMessage.isInstance)
        const action = String(human?.content)
        const parameters = action.startsWith("external") ? { value: 1 } : { book: 201 }
        return {
          generations: [
            {
              message: new AIMessage({
                content: "Calling action",
                tool_calls: [
                  { id: "status-update-call", name: "call", args: { action, parameters } },
                ],
              }),
            },
          ],
        }
      }
    }

    return createAgent({ model: new StatusUpdateModel({}), tools, middleware })
  }
}
