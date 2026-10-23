import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage } from "@langchain/core/messages"
import { toJSONSchema } from "zod"

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
    const lastMsg = messages[messages.length - 1]
    const lastType = lastMsg?._getType?.()

    if (this._tools?.length > 0) {
      if (lastType !== "tool") {
        const command = parseToolCommand(lastMsg?.content, this._tools)
        if (command) {
          return {
            generations: [{ message: command }],
            llmOutput: { model: `mock-${this.name}`, mock: true },
          }
        }

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

/** Interpret the small command language supported by the development mock. */
function parseToolCommand(content, tools) {
  if (typeof content !== "string") return null
  const input = content.trim()
  const names = tools.map((tool) => tool.name).filter(Boolean)

  if (/^tools$/i.test(input)) {
    return new AIMessage(names.join("\n"))
  }

  const detailsMatch = input.match(/^tool\s+(\S+)$/i)
  if (detailsMatch) {
    const name = detailsMatch[1]
    const selectedTool = tools.find((tool) => tool.name === name)
    if (!selectedTool) {
      return new AIMessage(`Unknown tool: ${name}. Available tools: ${names.join(", ")}`)
    }
    return new AIMessage(JSON.stringify(getToolDetails(selectedTool), null, 2))
  }

  let name
  let argsText
  const explicitCall = input.match(/^call:\s*(\S+)(?:\s+([\s\S]*))?$/i)
  if (explicitCall) {
    name = explicitCall[1]
    argsText = explicitCall[2] ?? ""
  } else {
    const selectedTool = [...tools]
      .filter((tool) => tool.name && (input === tool.name || input.startsWith(`${tool.name} `)))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (!selectedTool) return null
    name = selectedTool.name
    argsText = input.slice(name.length).trim()
  }

  const selectedTool = tools.find((tool) => tool.name === name)
  if (!selectedTool) {
    return new AIMessage(`Unknown tool: ${name}. Available tools: ${names.join(", ")}`)
  }

  return new AIMessage({
    content: "",
    tool_calls: [
      {
        id: `mock_${Date.now()}`,
        name,
        args: parseToolArguments(argsText, selectedTool),
      },
    ],
  })
}

function getToolDetails(tool) {
  let inputSchema = tool.schema
  try {
    if (tool.schema) inputSchema = toJSONSchema(tool.schema)
  } catch {
    // Some third-party tools expose schemas that are not Zod schemas.
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    ...(tool.metadata ? { metadata: tool.metadata } : {}),
  }
}

function parseToolArguments(rawArgs, tool) {
  const input = rawArgs.trim()
  if (!input) return {}

  try {
    const parsed = JSON.parse(input)
    if (Array.isArray(parsed)) return positionalArguments(parsed, tool)
    if (parsed && typeof parsed === "object") return parsed
  } catch {
    // Plain and key=value arguments are handled below.
  }

  const tokens = tokenizeArguments(input)
  if (tokens.length > 0 && tokens.every((token) => token.includes("="))) {
    return Object.fromEntries(
      tokens.map((token) => {
        const separator = token.indexOf("=")
        return [token.slice(0, separator), parseArgumentValue(token.slice(separator + 1))]
      }),
    )
  }

  return positionalArguments(tokens.map(parseArgumentValue), tool)
}

function positionalArguments(values, tool) {
  const keys = getToolArgumentNames(tool)
  return Object.fromEntries(values.map((value, index) => [keys[index] ?? `arg${index + 1}`, value]))
}

function getToolArgumentNames(tool) {
  const schema = tool.schema
  if (schema?.shape) return Object.keys(schema.shape)
  const properties = schema?.properties ?? schema?.jsonSchema?.properties
  return properties ? Object.keys(properties) : []
}

function tokenizeArguments(input) {
  return input.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? []
}

function parseArgumentValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return value
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
