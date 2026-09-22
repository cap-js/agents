import { ChatOpenAI } from '@langchain/openai'

export default class ChatOpenAIService extends ChatOpenAI {
  constructor (name, options = {}) {
    const { credentials = {} } = options
    super({ ...options, configuration: credentials })
    this.name = name
  }
}

