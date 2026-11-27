import { ChatOpenAI } from "@langchain/openai"
import { noTemp0Support } from "./utils/params.js"

export default class ChatOpenAIService extends ChatOpenAI {
  constructor(name, options = {}) {
    const { credentials = {}, model } = options
    if (options.temperature === 0 && noTemp0Support(model)) {
      delete options.temperature
    }
    if (
      !["gpt-3", "gpt-4", "gpt-5"].some((prefix) => model?.startsWith(prefix)) &&
      model !== "gpt-6-astra"
    ) {
      options = { useResponsesApi: true, ...options }
    }
    super({ ...options, configuration: credentials })
    this.name = name
  }
}
