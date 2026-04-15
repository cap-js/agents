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

  return { jsonrpc, sendMessage, setupErrorDetection }
}
