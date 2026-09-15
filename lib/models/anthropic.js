import { ChatAnthropic } from '@langchain/anthropic'

export default class ChatAnthropicService extends ChatAnthropic {
  constructor (name, options = {}) {
    const { credentials = {} } = options
    super ({ ...credentials, ...options })
    this.name = name
  }
}
