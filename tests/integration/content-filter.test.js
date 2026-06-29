/**
 * Integration tests for content filter configuration.
 *
 * Unit tests: verify buildContentFilter resolution logic.
 */
import cds from "@sap/cds"
import { setup, teardown, resetCapture, createSendMessage } from "../utils/telemetry-utils.js"
import { buildContentFilter } from "../../srv/handlers/content-filter.js"

process.env.CDS_TEST_SILENT = "false"
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")

const sendMessage = createSendMessage(POST)

// ─── Unit Tests: buildContentFilter resolution ────────────────────────────

describe("@cap-js/agents - Content Filter Configuration", () => {
  axios.defaults.validateStatus = () => true
  afterAll(teardown)
  beforeEach(resetCapture)

  describe("cds.env.agents.contentFilter (global config)", () => {
    let originalValue

    beforeEach(() => {
      originalValue = cds.env.agents.contentFilter
    })

    afterEach(() => {
      cds.env.agents.contentFilter = originalValue
    })

    it("should return undefined when set to false (disables filtering)", () => {
      cds.env.agents.contentFilter = false
      const result = buildContentFilter()
      expect(result).toBeUndefined()
    })

    it("should return undefined when set to 0", () => {
      cds.env.agents.contentFilter = 0
      const result = buildContentFilter()
      expect(result).toBeUndefined()
    })

    it("should passthrough dictionary object directly", () => {
      const custom = {
        input: { llama_guard_3_8b: { violent_crimes: true } },
        output: { azure_content_safety: { hate: "ALLOW_SAFE" } },
      }
      cds.env.agents.contentFilter = custom
      const result = buildContentFilter()
      expect(result).toBe(custom)
    })

    it("should return default dictionary when set to true", () => {
      cds.env.agents.contentFilter = true
      const result = buildContentFilter()

      expect(result.input.azure_content_safety).toBeDefined()
      expect(result.input.azure_content_safety.prompt_shield).toBe(true)
      expect(result.input.azure_content_safety.hate).toBe("ALLOW_SAFE_LOW")
      expect(result.output.azure_content_safety).toBeDefined()
      expect(result.output.azure_content_safety.hate).toBe("ALLOW_SAFE")
    })
  })

  describe("buildContentFilter event (per-service override)", () => {
    let originalValue

    beforeEach(() => {
      originalValue = cds.env.agents.contentFilter
      cds.env.agents.contentFilter = true
    })

    afterEach(() => {
      cds.env.agents.contentFilter = originalValue
    })

    it("should use global default when no service override", () => {
      const result = buildContentFilter()
      expect(result.input.azure_content_safety).toBeDefined()
      expect(result.input.azure_content_safety.prompt_shield).toBe(true)
    })

    it("should return undefined (disabled) when global is false", () => {
      cds.env.agents.contentFilter = false
      const result = buildContentFilter()
      expect(result).toBeUndefined()
    })
  })

  // ─── Resolution through srv.send("buildModel") ────────────────────────────

  describe("buildModel forwards contentFilter to OrchestrationClient", () => {
    let originalGlobal
    let originalLlm
    let srv
    let savedHandlers

    beforeAll(async () => {
      srv = await cds.connect.to("CatalogService")
      // Bookshop does not configure cds.env.agents.llm — set a stable name so
      // resolveModelName() does not throw during client construction.
      originalLlm = cds.env.agents.llm
      cds.env.agents.llm = cds.env.agents.llm || "test-only--filter-resolution"
    })

    afterAll(() => {
      cds.env.agents.llm = originalLlm
    })

    beforeEach(() => {
      originalGlobal = cds.env.agents.contentFilter
      cds.env.agents.contentFilter = true
      // Snapshot handler list so we can restore exactly after each test.
      savedHandlers = [...(srv.handlers?.on || [])]
    })

    afterEach(() => {
      cds.env.agents.contentFilter = originalGlobal
      if (srv.handlers?.on) srv.handlers.on.length = 0
      if (srv.handlers?.on && savedHandlers) srv.handlers.on.push(...savedHandlers)
    })

    // CAP runs `srv.on(event, …)` handlers in registration order; the default
    // `buildContentFilter` was registered on `cds.on("serving")` and is
    // already at the head of the chain. To simulate an app-side override
    // (which apps register inside `init()`, *before* the default), we use
    // `srv.prepend()` which unshifts our handler to the front.
    function override(handler) {
      srv.prepend((s) => s.on("buildContentFilter", handler))
    }

    it("disables filtering when override returns {}", async () => {
      override(() => ({}))
      const model = await srv.send("buildModel", { srv })
      expect(model.orchestrationConfig.filtering).toBeUndefined()
    })

    it("disables filtering when override returns false", async () => {
      override(() => false)
      const model = await srv.send("buildModel", { srv })
      expect(model.orchestrationConfig.filtering).toBeUndefined()
    })

    it("falls through to global config when override calls next()", async () => {
      override((req, next) => next())
      const model = await srv.send("buildModel", { srv })
      expect(model.orchestrationConfig.filtering).toBeDefined()
      expect(model.orchestrationConfig.filtering.input.filters[0]).toHaveProperty(
        "type",
        "azure_content_safety",
      )
    })

    it("disables filtering when no override and global is false", async () => {
      cds.env.agents.contentFilter = false
      const model = await srv.send("buildModel", { srv })
      expect(model.orchestrationConfig.filtering).toBeUndefined()
    })

    it("passes a non-empty filter dictionary through to the client (converted to SDK format)", async () => {
      const custom = {
        input: { azure_content_safety: { hate: "ALLOW_SAFE", prompt_shield: true } },
        output: { azure_content_safety: { hate: "ALLOW_SAFE" } },
      }
      override(() => custom)
      const model = await srv.send("buildModel", { srv })
      expect(model.orchestrationConfig.filtering).toBeDefined()
      expect(model.orchestrationConfig.filtering.input.filters[0].type).toBe("azure_content_safety")
      expect(model.orchestrationConfig.filtering.input.filters[0].config.hate).toBe(0) // ALLOW_SAFE → 0
      expect(model.orchestrationConfig.filtering.input.filters[0].config.prompt_shield).toBe(true)
    })
  })
})
