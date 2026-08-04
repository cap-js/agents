import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage } from "@langchain/core/messages"

const DEFAULT_MESSAGE =
  "[Mock LLM] This is a mocked response from @cap-js/agents development mode. No real LLM was invoked."

export default class MockChatModel extends BaseChatModel {
  constructor(name, options = {}) {
    super({})
    this.name = name
    this.options = options
    this._tools = []
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
        const args = queryTool && buildQueryArgs(queryTool, this._tools)
        if (args) {
          return {
            generations: [
              {
                message: new AIMessage({
                  content: "",
                  tool_calls: [{ id: `mock_${Date.now()}`, name: "query", args }],
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

/**
 * Build the args object for a mock `query` tool call
 * (works with format: cqn and cql)
 */
function buildQueryArgs(queryTool, tools) {
  // CQN mode
  const cqnEntities = queryTool?.schema?.shape?.entity?.def?.entries
  if (cqnEntities) {
    const entity = Object.keys(cqnEntities)[0]
    if (entity) return { entity, limit: 3 }
  }

  // CQL mode
  if (queryTool?.schema?.shape?.cql) {
    const describeTool = tools.find((t) => t.name === "describe")
    const describeEntities =
      describeTool?.schema?.shape?.entities?.def?.innerType?.def?.element?.def?.entries
    const entity = describeEntities && Object.keys(describeEntities)[0]
    if (entity) return { cql: `SELECT * FROM ${entity} LIMIT 3` }
  }

  return null
}

MockChatModel._is_service_class = true
