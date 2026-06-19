/**
 * Integration tests for content filter configuration.
 *
 * Unit tests: verify buildContentFilter resolution logic.
 */
import cds from "@sap/cds"
import { setup, teardown, resetCapture, createSendMessage } from "../utils/telemetry-utils.js"
import { buildContentFilter } from "../../srv/handlers/model.js"

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

    it("should return undefined when set to false (disables filtering)", async () => {
      cds.env.agents.contentFilter = false
      const result = await buildContentFilter()

      expect(result).toBeUndefined()
    })

    it("should return undefined when set to 0", async () => {
      cds.env.agents.contentFilter = 0
      const result = await buildContentFilter()

      expect(result).toBeUndefined()
    })

    it("should passthrough object directly", async () => {
      const custom = {
        input: { filters: [{ type: "custom", config: { level: 1 } }] },
        output: { filters: [] },
      }
      cds.env.agents.contentFilter = custom
      const result = await buildContentFilter()

      expect(result).toBe(custom)
    })

    it("should return Azure defaults when set to true", async () => {
      cds.env.agents.contentFilter = true
      const result = await buildContentFilter()

      expect(result.input.filters).toHaveLength(1)
      expect(result.input.filters[0]).toHaveProperty("type", "azure_content_safety")
      expect(result.output.filters).toHaveLength(1)
      expect(result.output.filters[0]).toHaveProperty("type", "azure_content_safety")
    })
  })

  describe("buildContentFilter event (per-service override)", () => {
    let originalValue

    beforeEach(() => {
      originalValue = cds.env.agents.contentFilter
      cds.env.agents.contentFilter = true // global enabled
    })

    afterEach(() => {
      cds.env.agents.contentFilter = originalValue
    })

    it("should use global default when no service override", async () => {
      const result = await buildContentFilter()

      expect(result.input.filters).toHaveLength(1)
      expect(result.input.filters[0]).toHaveProperty("type", "azure_content_safety")
    })

    it("should return undefined (disabled) when global is false", async () => {
      cds.env.agents.contentFilter = false
      const result = await buildContentFilter()

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

    it("falls through to global config when override returns undefined", async () => {
      override(() => undefined)
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

    it("passes a non-empty filter object straight through to the client", async () => {
      const custom = {
        input: { filters: [{ type: "azure_content_safety", config: {} }] },
        output: { filters: [] },
      }
      override(() => custom)
      const model = await srv.send("buildModel", { srv })
      expect(model.orchestrationConfig.filtering).toBe(custom)
    })
  })
})
