import { partsToText } from "../../../lib/utils/message-handling.js"

export class AbortError extends Error {
  constructor(message) {
    super(message)
    this.name = "AbortError"
    this.code = "ABORT_ERR"
  }
}

export class TimeoutError extends Error {
  constructor(message, { timeout } = {}) {
    super(message)
    this.name = "TimeoutError"
    this.code = "TIMEOUT_ERR"
    this.timeout = timeout
  }
}

export async function defaultInputMapper(requestContext) {
  const { HumanMessage } = await import("@langchain/core/messages")
  const text = partsToText(requestContext.userMessage?.parts)
  const fullText = requestContext._fileManifest ? `${text}\n${requestContext._fileManifest}` : text
  return { messages: [new HumanMessage(fullText)] }
}

export function messageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && block.text)
      .map((block) => block.text)
      .join("")
  }
  return ""
}

export function defaultOutputMapper(result) {
  if (result.messages?.length > 0) {
    const text = messageText(result.messages[result.messages.length - 1]?.content)
    if (text) return text
  }
  if (result.output) return result.output
  return JSON.stringify(result)
}
