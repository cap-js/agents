import { ChatOpenAI } from "@langchain/openai"

export default class ChatOpenAIService extends ChatOpenAI {
  constructor(name, options = {}) {
    const { credentials = {} } = options
    // GPT-6.1 Sol requires Responses for function tools with reasoning.
    const model = options.model ?? options.modelName ?? ""
    const useResponsesApi = options.useResponsesApi ?? /^gpt-6\.1-sol(?:-|$)/.test(model)
    super({ ...options, useResponsesApi, configuration: credentials })
    this.name = name
  }
}
