import { describe, it, expect, vi } from "vitest"
import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import Model from "../../lib/models/aicore.js"

describe("programmatic AI Core model", () => {
  it("omits unsupported caching parameters when disabled", async () => {
    const model = new Model("editor", { model: "gpt-6.1-sol", promptCaching: false, contentFilter: false, streaming: false, params: { max_tokens: 4096 } })
    expect(model.orchestrationConfig.promptTemplating.model.params).toEqual({ max_tokens: 4096 })
    const generate = vi.spyOn(OrchestrationClient.prototype, "_generate").mockImplementation(async (_messages, options) => {
      expect(model.mergeOrchestrationConfig(model.orchestrationConfig, options).promptTemplating.model.params.prompt_cache_key).toBeUndefined()
      return { generations: [] }
    })
    try { await model._generate([], {}) } finally { generate.mockRestore() }
  })

  it("retains provider diagnostics and status without serializing request credentials", async () => {
    const model = new Model("editor", { model: "gpt-6.1-sol", promptCaching: false, contentFilter: false })
    const generate = vi.spyOn(OrchestrationClient.prototype, "_generate").mockRejectedValue({ rootCause: { message: "HTTP 400", config: { headers: { authorization: "private-token" } }, response: { status: 400, data: { error: { message: "Unsupported parameter" } } } } })
    try { await expect(model._generate([], {})).rejects.toMatchObject({ message: "Unsupported parameter", status: 400 }) } finally { generate.mockRestore() }
  })
})
