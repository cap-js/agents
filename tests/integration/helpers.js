import cds from "@sap/cds"

export default ({ POST, axios }) => {
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
    // responseType: 'text' makes naxios call res.text(), which waits for the
    // server to close the connection (res.end()) and returns the complete SSE
    // body as a plain string. This is portable across Node versions and avoids
    // leaving unread ReadableStreams open (which would count against the
    // concurrent-task quota in hybrid mode).
    return POST(
      `/a2a/${service}/`,
      {
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
      },
      { responseType: "text" },
    )
  }

  /**
   * Parse a text/event-stream response body string into an array of parsed
   * JSON-RPC envelopes. Each SSE frame has the wire format: "data: <JSON>\n\n"
   */
  function parseSSEFrames(body) {
    return body
      .split("\n\n")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("data: "))
      .map((part) => JSON.parse(part.slice(6)))
  }

  /**
   * Detects silent tool/executor failures in console.error output.
   * Returns { before, after } hooks to call manually in each test.
   *
   * Usage:
   *   const errorDetection = setupErrorDetection()
   *   // before each test: errorDetection.before()
   *   // after each test:  errorDetection.after()
   */
  function setupErrorDetection() {
    const errors = []
    let originalError

    function before() {
      errors.length = 0
      originalError = console.error
      console.error = (...args) => {
        const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
        errors.push(msg)
        originalError.apply(console, args)
      }
    }

    function after() {
      console.error = originalError
      const relevantErrors = errors.filter((e) => /\[a2a\]|\[mcp\]/.test(e))
      if (relevantErrors.length > 0) {
        throw new Error(`Errors detected during test:\n${relevantErrors.join("\n")}`)
      }
    }

    return { before, after }
  }

  return { jsonrpc, sendMessage, streamMessage, parseSSEFrames, setupErrorDetection }
}
