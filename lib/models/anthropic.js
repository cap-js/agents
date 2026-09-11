import { ChatAnthropic } from '@langchain/anthropic'
import cds from '@sap/cds'

export default class ChatAnthropicService extends ChatAnthropic {
  constructor (name, options) {
    let { credentials } = cds.requires.llm
    super ({ ...credentials, ...options })
    this.name = name
  }
}
