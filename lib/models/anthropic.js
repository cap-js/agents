import { ChatAnthropic } from '@langchain/anthropic'
import { withPromptCachingMessages } from '../utils/caching.js'

export default class ChatAnthropicService extends ChatAnthropic {
  constructor (name, options = {}) {
    const { credentials = {} } = options
    super ({ ...credentials, ...options })
    this.name = name
  }

  async _generate (messages, options, runManager) {
    const cached = withPromptCachingMessages(this.model, messages, options)
    return super._generate(cached.messages, cached.opts, runManager)
  }

  async *_streamResponseChunks (messages, options, runManager) {
    const cached = withPromptCachingMessages(this.model, messages, options)
    yield* super._streamResponseChunks(cached.messages, cached.opts, runManager)
  }
}
