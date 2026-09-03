/**
 * Tests for AICore destination-based connectivity.
 *
 * Verifies that when `destinationName` is configured, the SDK receives
 * the correct destination and deploymentConfig (resourceGroup) parameters
 * instead of relying on a service binding (VCAP_SERVICES).
 */
import cds from "@sap/cds"
import InstrumentedOrchestrationClient from "../../lib/models/aicore.js"
import {
  buildPromptCacheKey,
  withPromptCachingOptions,
  withPromptCachingParams,
} from "../../lib/models/aicore-caching.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

const MODEL_NAME = "anthropic--claude-4.6-sonnet"

describe("@cap-js/agents - AICore Destination Connectivity", () => {
  describe("constructor - destination parameters", () => {
    it("sets destination when destinationName is provided", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        contentFilter: false,
      })
      expect(model.destination).toEqual({ destinationName: "my-aicore-dest" })
    })

    it("sets deploymentConfig with default resourceGroup when destinationName provided", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        contentFilter: false,
      })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "default" })
    })

    it("uses explicit resourceGroup when provided with destinationName", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        resourceGroup: "my-custom-group",
        contentFilter: false,
      })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "my-custom-group" })
    })

    it("sets resourceGroup without destination when only resourceGroup is provided", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        resourceGroup: "custom-group",
        contentFilter: false,
      })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "custom-group" })
      expect(model.destination).toBeUndefined()
    })

    it("leaves destination and deploymentConfig undefined when neither configured", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        contentFilter: false,
      })
      expect(model.destination).toBeUndefined()
      expect(model.deploymentConfig).toBeUndefined()
    })

    it("preserves all other constructor behavior when destination is configured", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        params: { temperature: 0.5, max_tokens: 2048 },
        contentFilter: true,
      })
      // orchestrationConfig still set correctly
      expect(model.orchestrationConfig.promptTemplating.model.name).toBe(MODEL_NAME)
      expect(model.orchestrationConfig.promptTemplating.model.params).toEqual({
        temperature: 0.5,
        max_tokens: 2048,
      })
      // content filter still applied
      expect(model.orchestrationConfig.filtering).toBeDefined()
      expect(model.orchestrationConfig.filtering.output).toBeDefined()
    })
  })

  describe("buildModel integration - destination via cds.requires", () => {
    let srv, savedHandlers

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

    it("passes destinationName from config options to model", async () => {
      srv.prepend((s) =>
        s.on(
          "buildModel",
          () =>
            new InstrumentedOrchestrationClient(MODEL_NAME, {
              model: MODEL_NAME,
              destinationName: "prod-aicore",
              resourceGroup: "agents",
              contentFilter: false,
            }),
        ),
      )
      const model = await srv.send("buildModel", {})
      expect(model.destination).toEqual({ destinationName: "prod-aicore" })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "agents" })
    })
  })

  describe("prompt caching", () => {
    let previousContext

    beforeEach(() => {
      previousContext = cds.context
      cds.context = {
        tenant: "tenant-1",
        user: { id: "user-1" },
        "agent.service": "CatalogService",
        "agent.context.id": "ctx-1",
      }
    })

    afterEach(() => {
      cds.context = previousContext
    })

    it("adds GPT-5.5 retention params", () => {
      expect(withPromptCachingParams("gpt-5.5", { temperature: 0 })).toEqual({
        temperature: 0,
        prompt_cache_retention: "24h",
      })
    })

    it("adds GPT-5.6 prompt cache options", () => {
      expect(withPromptCachingParams("gpt-5.6-sol", { temperature: 0 })).toEqual({
        temperature: 0,
        prompt_cache_options: { mode: "implicit", ttl: "30m" },
      })
    })

    it("does not override caller-provided GPT cache params", () => {
      expect(
        withPromptCachingParams("gpt-5.6", {
          prompt_cache_options: { mode: "explicit" },
          prompt_cache_key: "custom-key",
        }),
      ).toEqual({
        prompt_cache_options: { mode: "explicit" },
        prompt_cache_key: "custom-key",
      })
    })

    it("sets SDK cache_control for Claude and Nova models", () => {
      expect(withPromptCachingOptions("anthropic--claude-4.6-sonnet", {}).cache_control).toEqual({
        type: "ephemeral",
      })
      expect(withPromptCachingOptions("amazon--nova-pro", {}).cache_control).toEqual({
        type: "ephemeral",
      })
    })

    it("merges a generated prompt_cache_key into GPT model params per request", () => {
      const model = new InstrumentedOrchestrationClient("llm", {
        model: "gpt-5.5",
        params: { temperature: 0 },
        contentFilter: false,
      })

      const opts = withPromptCachingOptions("gpt-5.5", {
        configurable: { _service: "CatalogService", _userId: "user-1", thread_id: "svc:ctx-1" },
      })
      const merged = model.mergeOrchestrationConfig(model.orchestrationConfig, opts)

      expect(merged.promptTemplating.model.params).toMatchObject({
        temperature: 0,
        prompt_cache_retention: "24h",
      })
      expect(merged.promptTemplating.model.params.prompt_cache_key).toMatch(
        /^cap-agents:catalogservice:gpt-5\.5:[a-f0-9]{16}$/,
      )
    })

    it("preserves caller-provided prompt_cache_key", () => {
      const model = new InstrumentedOrchestrationClient("llm", {
        model: "gpt-5.5",
        params: { prompt_cache_key: "custom-key" },
        contentFilter: false,
      })
      const opts = withPromptCachingOptions("gpt-5.5", {
        configurable: { _service: "CatalogService", _userId: "user-1" },
      })
      const merged = model.mergeOrchestrationConfig(model.orchestrationConfig, opts)

      expect(merged.promptTemplating.model.params.prompt_cache_key).toBe("custom-key")
    })

    it("builds stable non-secret cache keys", () => {
      const key1 = buildPromptCacheKey("gpt-5.5", {
        configurable: { _service: "CatalogService", _userId: "user-1" },
      })
      const key2 = buildPromptCacheKey("gpt-5.5", {
        configurable: { _service: "CatalogService", _userId: "user-1" },
      })

      expect(key1).toBe(key2)
      expect(key1).toMatch(/^cap-agents:catalogservice:gpt-5\.5:[a-f0-9]{16}$/)
      expect(key1).not.toContain("user-1")
    })
  })
})
