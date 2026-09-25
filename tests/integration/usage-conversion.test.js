import { convertUsageData } from "../../lib/telemetry/chat-tracing.js"
import { isAdditiveCacheUsageModel, normalizeAdditiveCacheUsage } from "../../lib/utils/usage.js"

function convertNormalizedAdditiveCacheUsage(usage) {
  const result = { generations: [{ message: { usage_metadata: usage } }] }
  normalizeAdditiveCacheUsage(result)
  return convertUsageData(result.generations[0].message.usage_metadata)
}

describe("additive cache usage normalization", () => {
  it("matches Anthropic and AWS Bedrock model names", () => {
    expect(isAdditiveCacheUsageModel("anthropic--claude-4.6-sonnet")).toBe(true)
    expect(isAdditiveCacheUsageModel("claude-3-5-sonnet")).toBe(true)
    expect(isAdditiveCacheUsageModel("amazon--nova-pro")).toBe(true)
    expect(isAdditiveCacheUsageModel("gpt-5.6-luna")).toBe(false)
  })

  it("adds cache tokens to input tokens", () => {
    const usage = convertNormalizedAdditiveCacheUsage({
      input_tokens: 50,
      output_tokens: 10,
      total_tokens: 9560,
      input_token_details: {
        cache_creation: 1_500,
        cache_read: 8_000,
      },
    })

    expect(usage.input_tokens).toBe(9_550)
    expect(usage.output_tokens).toBe(10)
    expect(usage.total_tokens).toBe(9560)
    expect(usage.cache_creation_input_tokens).toBe(1_500)
    expect(usage.cache_read_input_tokens).toBe(8_000)
  })

  it("leaves total undefined when provider did not send total tokens", () => {
    const usage = convertNormalizedAdditiveCacheUsage({
      input_tokens: 50,
      output_tokens: 10,
      input_token_details: { cache_read: 100_000 },
    })

    expect(usage.input_tokens).toBe(100_050)
    expect(usage.total_tokens).toBe(undefined)
  })

  it("does not add cache tokens twice", () => {
    const result = {
      generations: [
        {
          message: {
            usage_metadata: {
              input_tokens: 112,
              output_tokens: 53,
              total_tokens: 165,
              input_token_details: { cache_read: 5_303, cache_creation: 0 },
            },
          },
        },
      ],
    }

    normalizeAdditiveCacheUsage(result)
    normalizeAdditiveCacheUsage(result)
    const usage = convertUsageData(result.generations[0].message.usage_metadata)

    expect(usage.input_tokens).toBe(5_415)
    expect(usage.total_tokens).toBe(5_468)
  })

  it("normalizes cache creation totals", () => {
    const usage = convertNormalizedAdditiveCacheUsage({
      input_tokens: 3,
      output_tokens: 72,
      total_tokens: 75,
      input_token_details: { cache_read: 0, cache_creation: 5_303 },
      output_token_details: {},
    })

    expect(usage.input_tokens).toBe(5_306)
    expect(usage.output_tokens).toBe(72)
    expect(usage.total_tokens).toBe(5_378)
  })

  it("normalizes cache read totals", () => {
    const usage = convertNormalizedAdditiveCacheUsage({
      input_tokens: 112,
      output_tokens: 53,
      total_tokens: 165,
      input_token_details: { cache_read: 5_303, cache_creation: 0 },
      output_token_details: {},
    })

    expect(usage.input_tokens).toBe(5_415)
    expect(usage.output_tokens).toBe(53)
    expect(usage.total_tokens).toBe(5_468)
  })

  it("keeps inclusive input tokens when total proves cache already counted", () => {
    const usage = convertUsageData({
      input_tokens: 10_000,
      output_tokens: 200,
      total_tokens: 10_200,
      input_token_details: { cache_read: 8_000, cache_creation: 1_500 },
    })

    expect(usage.input_tokens).toBe(10_000)
    expect(usage.total_tokens).toBe(10_200)
  })

  it("keeps non-normalized usage unchanged", () => {
    const usage = convertUsageData({
      input_tokens: 500,
      output_tokens: 200,
      total_tokens: 10_200,
      input_token_details: { cache_read: 8_000, cache_creation: 1_500 },
    })

    expect(usage.input_tokens).toBe(500)
    expect(usage.total_tokens).toBe(10_200)
  })
})
