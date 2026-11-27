import { isTextMime } from "../../lib/agents/markdown/backends/mime-utils.js"
import { PseudonymStore } from "../../lib/masking/store.js"
import { metricsFromSpans } from "../../lib/eval/metrics.js"

describe("mime-utils / masking store / eval metrics edge cases", () => {
  it("normalizes case and parameters in isTextMime", () => {
    expect(isTextMime("application/json; charset=utf-8")).toBe(true)
    expect(isTextMime("TEXT/PLAIN; charset=UTF-8")).toBe(true)
    expect(isTextMime(" Application/XML ; charset=utf-8 ")).toBe(true)
    expect(isTextMime("image/png")).toBe(false)
    expect(isTextMime("")).toBe(false)
  })

  it("scrubText and resolveText perform single-pass replacement without cross-entry tag corruption", () => {
    const store = new PseudonymStore("fixed-seed-for-unit-test")
    const tag1 = store.pseudonymize("John", "name")
    const tag2 = store.pseudonymize("name", "word")
    expect(tag1).not.toBe(tag2)

    const scrubbed = store.scrubText("John name")
    expect(scrubbed).toBe(`${tag1} ${tag2}`)
    expect(store.resolveText(scrubbed)).toBe("John name")
  })

  it("metricsFromSpans ignores non-finite token and cost values without producing NaN", () => {
    const result = metricsFromSpans([
      {
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": "invalid",
          "gen_ai.usage.output_tokens": 25,
          "mlflow.llm.cost": JSON.stringify({ total_cost: "not-a-number" }),
        },
      },
      {
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": Number.NaN,
          "mlflow.llm.cost": JSON.stringify({ total_cost: 0.05 }),
        },
      },
    ])

    expect(result.input_tokens).toBe(10)
    expect(result.output_tokens).toBe(25)
    expect(result.total_tokens).toBe(35)
    expect(result.cost_usd).toBeCloseTo(0.05)
  })
})
