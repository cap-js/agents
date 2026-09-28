const NORMALIZED = Symbol.for("@cap-js/agents:additive-cache-usage-normalized")

export function isAdditiveCacheUsageModel(model) {
  const name = String(model || "")
  return /anthropic|claude/i.test(name) || /^amazon--/i.test(name)
}

export function normalizeAdditiveCacheUsage(result) {
  for (const message of result?.generations?.map((g) => g.message) ?? []) {
    if (message?.id === message?.additional_kwargs?.intermediate_results?.llm?.id) {
      continue
    } else if (message && !message.id) {
      message.id = message?.additional_kwargs?.intermediate_results?.llm?.id
    }
    normalizeAdditiveCacheUsageMetadata(message?.usage_metadata)
  }
  return result
}

export function normalizeAdditiveCacheUsageChunk(chunk) {
  normalizeAdditiveCacheUsageMetadata(chunk?.message?.usage_metadata)
  // Without the mesage.id check, its possible that a chunk is generated, usage adjusted, and then logic runs again during final _generate
  if (chunk?.message?.usage_metadata)
    chunk.message.id = chunk.message?.additional_kwargs?.intermediate_results?.llm?.id
  return chunk
}

function normalizeAdditiveCacheUsageMetadata(usage) {
  if (!usage || usage[NORMALIZED]) return
  const cache =
    (usage.input_token_details?.cache_read ?? 0) + (usage.input_token_details?.cache_creation ?? 0)
  if (!cache) return

  usage.input_tokens += cache
  if (usage.total_tokens != null && usage.output_tokens != null) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens
  }
  Object.defineProperty(usage, NORMALIZED, { value: true, enumerable: true })
}
