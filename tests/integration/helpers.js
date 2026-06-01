const cds = require("@sap/cds")

module.exports = ({ POST, axios }) => {
  axios.defaults.validateStatus = () => true

  function jsonrpc(service, method, params = {}) {
    return POST(`/a2a/${service}/`, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    })
  }

  function sendMessage(service, text, { contextId, taskId } = {}) {
    return jsonrpc(service, "message/send", {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        ...(taskId && { taskId }),
        parts: [{ kind: "text", text }],
      },
    })
  }

  function streamMessage(service, text) {
    return POST(`/a2a/${service}/`, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/stream",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [{ kind: "text", text }],
        },
      },
    })
  }

  /**
   * Drain a text/event-stream ReadableStream into an array of parsed JSON-RPC envelopes.
   * Each SSE frame has the wire format: "data: <JSON>\n\n"
   */
  async function parseSSEFrames(stream) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const frames = []
    let buf = ""
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n\n")
      buf = parts.pop() // keep any incomplete trailing chunk
      for (const part of parts) {
        const line = part.trim()
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)))
      }
    }
    return frames
  }

  /**
   * Detects silent tool/executor failures in console.error output.
   * Catch tool execution failures, etc. that the LLM might cover up with
   * a polite "technical issue" response while still returning "completed".
   */
  function setupErrorDetection() {
    const errors = []
    let originalError

    beforeEach(() => {
      errors.length = 0
      originalError = console.error
      console.error = (...args) => {
        const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
        errors.push(msg)
        originalError.apply(console, args)
      }
    })

    afterEach(() => {
      console.error = originalError
      const relevantErrors = errors.filter((e) => /\[a2a\]|\[mcp\]/.test(e))
      if (relevantErrors.length > 0) {
        throw new Error(`Errors detected during test:\n${relevantErrors.join("\n")}`)
      }
    })
  }

  return { jsonrpc, sendMessage, streamMessage, parseSSEFrames, setupErrorDetection }
}
