/**
 * Tests for content filter configuration.
 *
 * - Unit tests: buildContentFilter() pure function and toSdkFilterFormat() conversion.
 * - Integration tests: InstrumentedOrchestrationClient constructor behavior via buildModel.
 */
import cds from "@sap/cds"
import { buildContentFilter, toSdkFilterFormat } from "../../lib/models/aicore.js"
import InstrumentedOrchestrationClient from "../../lib/models/aicore.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

describe("@cap-js/agents - Content Filter Configuration", () => {
  // ─── Unit Tests: buildContentFilter() pure function ───────────────────────

  describe("buildContentFilter() - fixed defaults", () => {
    it("returns the default input filter with azure_content_safety", () => {
      const result = buildContentFilter()
      expect(result.input.azure_content_safety).toBeDefined()
    })

    it("sets prompt_shield on input filter", () => {
      const result = buildContentFilter()
      expect(result.input.azure_content_safety.prompt_shield).toBe(true)
    })

    it("sets hate threshold to ALLOW_SAFE_LOW on input filter", () => {
      const result = buildContentFilter()
      expect(result.input.azure_content_safety.hate).toBe("ALLOW_SAFE_LOW")
    })

    it("returns the default output filter with azure_content_safety", () => {
      const result = buildContentFilter()
      expect(result.output.azure_content_safety).toBeDefined()
    })

    it("sets hate threshold to ALLOW_SAFE on output filter", () => {
      const result = buildContentFilter()
      expect(result.output.azure_content_safety.hate).toBe("ALLOW_SAFE")
    })

    it("is a pure function — returns same structure on every call", () => {
      expect(buildContentFilter()).toEqual(buildContentFilter())
    })
  })

  // ─── Unit Tests: toSdkFilterFormat() conversion ──────────────────────────

  describe("toSdkFilterFormat() - SDK format conversion", () => {
    it("converts ALLOW_SAFE to 0", () => {
      const result = toSdkFilterFormat({ output: { azure_content_safety: { hate: "ALLOW_SAFE" } } })
      expect(result.output.filters[0].config.hate).toBe(0)
    })

    it("converts ALLOW_SAFE_LOW to 2", () => {
      const result = toSdkFilterFormat({
        input: { azure_content_safety: { hate: "ALLOW_SAFE_LOW" } },
      })
      expect(result.input.filters[0].config.hate).toBe(2)
    })

    it("converts ALLOW_SAFE_LOW_MEDIUM to 4", () => {
      const result = toSdkFilterFormat({
        output: { azure_content_safety: { violence: "ALLOW_SAFE_LOW_MEDIUM" } },
      })
      expect(result.output.filters[0].config.violence).toBe(4)
    })

    it("passes boolean values through unchanged (prompt_shield)", () => {
      const result = toSdkFilterFormat({ input: { azure_content_safety: { prompt_shield: true } } })
      expect(result.input.filters[0].config.prompt_shield).toBe(true)
    })

    it("wraps filters in { filters: [{ type, config }] } SDK format", () => {
      const result = toSdkFilterFormat({ output: { azure_content_safety: { hate: "ALLOW_SAFE" } } })
      expect(result.output.filters[0]).toHaveProperty("type", "azure_content_safety")
      expect(result.output.filters[0]).toHaveProperty("config")
    })

    it("handles input and output independently", () => {
      const result = toSdkFilterFormat({
        input: { azure_content_safety: { hate: "ALLOW_SAFE_LOW" } },
        output: { azure_content_safety: { hate: "ALLOW_SAFE" } },
      })
      expect(result.input.filters[0].config.hate).toBe(2)
      expect(result.output.filters[0].config.hate).toBe(0)
    })
  })

  // ─── Integration: InstrumentedOrchestrationClient constructor ─────────────
  // buildModel calls cds.connect.to(provider, req.data) which instantiates
  // InstrumentedOrchestrationClient. Tests verify constructor behavior by
  // overriding buildModel to build the client directly with known options.

  describe("buildModel → InstrumentedOrchestrationClient content filter options", () => {
    const MODEL_NAME = "test-only--filter-resolution"
    let srv
    let savedHandlers

    beforeAll(async () => {
      srv = await cds.connect.to("CatalogService")
    })

    beforeEach(() => {
      savedHandlers = [...(srv.handlers?.on || [])]
    })

    afterEach(() => {
      if (srv.handlers?.on) srv.handlers.on.length = 0
      if (srv.handlers?.on && savedHandlers) srv.handlers.on.push(...savedHandlers)
    })

    // Override buildModel to construct InstrumentedOrchestrationClient directly
    // (bypasses cds.connect.to so integration tests work without a real LLM service).
    function overrideModel(contentFilter) {
      srv.prepend((s) =>
        s.on(
          "buildModel",
          () =>
            new InstrumentedOrchestrationClient(MODEL_NAME, {
              model: MODEL_NAME,
              contentFilter,
            }),
        ),
      )
    }

    it("applies default output filter when no contentFilter option given", async () => {
      overrideModel(undefined)
      const model = await srv.send("buildModel", {})
      expect(model.orchestrationConfig.filtering).toBeDefined()
      expect(model.orchestrationConfig.filtering.output.filters[0]).toHaveProperty(
        "type",
        "azure_content_safety",
      )
    })

    it("stores default input filter in options.contentFilter for middleware", async () => {
      overrideModel(undefined)
      const model = await srv.send("buildModel", {})
      expect(model.options.contentFilter.input.azure_content_safety).toBeDefined()
      expect(model.options.contentFilter.input.azure_content_safety.prompt_shield).toBe(true)
    })

    it("only passes output filter to SDK — input filter stays in options for middleware", async () => {
      overrideModel(undefined)
      const model = await srv.send("buildModel", {})
      // SDK receives output only
      expect(model.orchestrationConfig.filtering.output).toBeDefined()
      expect(model.orchestrationConfig.filtering.input).toBeUndefined()
    })

    it("applies explicit custom contentFilter object", async () => {
      const custom = {
        input: { azure_content_safety: { hate: "ALLOW_SAFE", prompt_shield: true } },
        output: { azure_content_safety: { hate: "ALLOW_SAFE" } },
      }
      overrideModel(custom)
      const model = await srv.send("buildModel", {})
      expect(model.orchestrationConfig.filtering).toBeDefined()
      expect(model.orchestrationConfig.filtering.output.filters[0].type).toBe(
        "azure_content_safety",
      )
      expect(model.orchestrationConfig.filtering.output.filters[0].config.hate).toBe(0) // ALLOW_SAFE → 0
    })

    it("stores custom input filter in options.contentFilter for middleware", async () => {
      const custom = {
        input: { azure_content_safety: { hate: "ALLOW_SAFE", prompt_shield: true } },
        output: { azure_content_safety: { hate: "ALLOW_SAFE" } },
      }
      overrideModel(custom)
      const model = await srv.send("buildModel", {})
      expect(model.options.contentFilter.input.azure_content_safety.prompt_shield).toBe(true)
    })

    it("normalises contentFilter: true to the default filter object", async () => {
      overrideModel(true)
      const model = await srv.send("buildModel", {})
      expect(model.options.contentFilter).toEqual(buildContentFilter())
    })
  })
})
