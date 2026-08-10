import http from "node:http"

/**
 * Lightweight mock for SAP AI Core orchestration endpoint.
 *
 * Handles POST /v2/inference/deployments/<id>/v2/completion
 * Returns configurable HTTP status codes with appropriate response bodies.
 * Supports both non-streaming (JSON) and streaming (SSE) responses.
 */
export function createMockAICore() {
  let responseStatus = 200
  let callCount = 0
  let finishReason = "stop"
  let responseContent = "Mock LLM response from AI Core."
  let model = "mock-gpt-4"
  let reasoningTokens = null

  function buildUsage() {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (reasoningTokens != null) {
      usage.completion_tokens_details = { reasoning_tokens: reasoningTokens }
    }
    return usage
  }

  function buildSuccessBody() {
    return JSON.stringify({
      request_id: "mock-req-001",
      final_result: {
        model,
        usage: buildUsage(),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseContent },
            finish_reason: finishReason,
          },
        ],
      },
      intermediate_results: {},
    })
  }

  /** Build SSE chunks for streaming response */
  function buildSSEChunks() {
    const usage = buildUsage()
    // Chunk 1: content delta
    const chunk1 = JSON.stringify({
      request_id: "mock-req-001",
      final_result: {
        model,
        choices: [
          { index: 0, delta: { role: "assistant", content: responseContent }, finish_reason: null },
        ],
      },
      intermediate_results: {},
    })
    // Chunk 2: finish + usage (final chunk)
    const chunk2 = JSON.stringify({
      request_id: "mock-req-001",
      final_result: {
        model,
        usage,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      },
      intermediate_results: {},
    })
    return [chunk1, chunk2]
  }

  function isStreamingRequest(req) {
    // SDK sends { config: { stream: { enabled: true }, ... } }
    try {
      const parsed = JSON.parse(req._body)
      return parsed?.config?.stream?.enabled === true
    } catch {
      return false
    }
  }

  const server = http.createServer((req, res) => {
    callCount++

    // Buffer body to detect streaming flag
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      req._body = body
      const streaming = isStreamingRequest(req)

      if (responseStatus >= 400) {
        res.setHeader("Content-Type", "application/json")
        res.writeHead(responseStatus)
        res.end(
          JSON.stringify({
            error: {
              message: `Mock AI Core error: ${responseStatus}`,
              code: String(responseStatus),
            },
          }),
        )
        return
      }

      if (isStreamingRequest(req)) {
        // SSE streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        const chunks = buildSSEChunks()
        for (const chunk of chunks) {
          res.write(`data: ${chunk}\n\n`)
        }
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        // Non-streaming JSON response
        res.setHeader("Content-Type", "application/json")
        res.writeHead(200)
        res.end(buildSuccessBody())
      }
    })
  })

  return {
    server,
    start: () => new Promise((resolve) => server.listen(0, () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve)),
    setModel: (m) => (model = m),
    setStatus: (status) => (responseStatus = status),
    getCallCount: () => callCount,
    resetCallCount: () => (callCount = 0),
    setFinishReason: (reason) => (finishReason = reason),
    setResponseContent: (content) => (responseContent = content),
    setReasoningTokens: (n) => (reasoningTokens = n),
  }
}
