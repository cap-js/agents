import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage } from "@langchain/core/messages"

const DEFAULT_MESSAGE =
  "[Mock LLM] This is a mocked response from @cap-js/agents development mode. No real LLM was invoked."

export default class MockChatModel extends BaseChatModel {
  constructor(name, model, options = {}) {
    super({})
    this.name = name
    this.options = options
    this._tools = []
  }

  init() {
    return this
  }

  _llmType() {
    return "cap-mock-llm"
  }

  bindTools(tools) {
    const bound = Object.create(this)
    bound._tools = tools ?? []
    return bound
  }

  async _generate(messages) {
    const message = this.options.message || DEFAULT_MESSAGE

    if (this._tools?.length > 0) {
      const lastMsg = messages[messages.length - 1]
      const lastType = lastMsg?._getType?.()

      if (lastType !== "tool") {
        const queryTool = this._tools.find((t) => t.name === "query")
        const entities = queryTool?.schema?.shape.entity?.def.entries
        if (queryTool && entities) {
          const entity = Object.keys(entities)[0]
          return {
            generations: [
              {
                message: new AIMessage({
                  content: "",
                  tool_calls: [
                    { id: `mock_${Date.now()}`, name: "query", args: { entity, limit: 3 } },
                  ],
                }),
              },
            ],
            llmOutput: { model: `mock-${this.name}`, mock: true },
          }
        }
      } else {
        const toolResult = lastMsg?.content ?? ""
        return {
          generations: [{ message: new AIMessage(`${message}\n\nTool result: ${toolResult}`) }],
          llmOutput: { model: `mock-${this.name}`, mock: true },
        }
      }
    }

    return {
      generations: [{ message: new AIMessage(message) }],
      llmOutput: { model: `mock-${this.name}`, mock: true },
    }
  }
}

MockChatModel._is_service_class = true
