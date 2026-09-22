import { ChatOpenAI } from '@langchain/openai'

export default class ChatOpenAIService extends ChatOpenAI {
  constructor (name, options = {}) {
    super (options)
    this.name = name
  }
}

