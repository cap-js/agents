import http from "node:http"

/**
 * Lightweight mock for SAP AI Core orchestration endpoint.
 *
 * Handles POST /v2/inference/deployments/<id>/v2/completion
 * Returns configurable HTTP status codes with appropriate response bodies.
 */
export function createMockAICore() {
  let responseStatus = 200
  let callCount = 0

  const successBody = JSON.stringify({
    request_id: "mock-req-001",
    final_result: {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Mock LLM response from AI Core." },
          finish_reason: "stop",
        },
      ],
    },
    intermediate_results: {},
  })

  const server = http.createServer((req, res) => {
    callCount++
    res.setHeader("Content-Type", "application/json")
    if (responseStatus >= 400) {
      res.writeHead(responseStatus)
      res.end(
        JSON.stringify({
          error: { message: `Mock AI Core error: ${responseStatus}`, code: String(responseStatus) },
        }),
      )
    } else {
      res.writeHead(200)
      res.end(successBody)
    }
  })

  return {
    server,
    start: () => new Promise((resolve) => server.listen(0, () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve)),
    setStatus: (status) => {
      responseStatus = status
    },
    getCallCount: () => callCount,
    resetCallCount: () => {
      callCount = 0
    },
  }
}
