function _hrtimeToMs(hr) {
  return hr[0] * 1000 + hr[1] / 1e6
}

/**
 * @param {object[]} spans     Finished OTel spans from span-collector.js
 * @param {number}   [latencyMs] Wall-clock fallback for latency
 * @returns {{ input_tokens, output_tokens, total_tokens, tool_call_count, latency_ms, cost_usd }}
 */
export function metricsFromSpans(spans, latencyMs = null) {
  let input_tokens = 0
  let output_tokens = 0
  let tool_call_count = 0
  let cost_usd = 0
  let latency_ms = null

  for (const span of spans) {
    const attrs = span.attributes ?? {}
    const op = attrs["gen_ai.operation.name"]

    if (op === "chat") {
      input_tokens += Number(attrs["gen_ai.usage.input_tokens"] ?? 0)
      output_tokens += Number(attrs["gen_ai.usage.output_tokens"] ?? 0)

      // mlflow.llm.cost is set by apps themselves
      const rawCost = attrs["mlflow.llm.cost"]
      if (rawCost) {
        try {
          const c = typeof rawCost === "string" ? JSON.parse(rawCost) : rawCost
          cost_usd += c.total_cost ?? 0
        } catch {
          /* malformed — skip */
        }
      }
    }

    if (op === "execute_tool") {
      tool_call_count++
    }

    if (op === "invoke_agent" && span.endTime && span.startTime) {
      latency_ms = _hrtimeToMs(span.endTime) - _hrtimeToMs(span.startTime)
    }
  }

  if (latency_ms === null) latency_ms = latencyMs

  return {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
    tool_call_count,
    latency_ms,
    cost_usd: cost_usd > 0 ? cost_usd : null,
  }
}
