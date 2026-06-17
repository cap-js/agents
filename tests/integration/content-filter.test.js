/**
 * Integration tests for content filter configuration.
 *
 * Unit tests (always run): verify buildContentFilter resolution logic.
 * Hybrid tests (AI Core required): verify filter actually blocks/allows.
 *
 * Run with: npm run test:hybrid (for hybrid section)
 */
import cds from "@sap/cds"
import { setup, teardown, resetCapture, createSendMessage } from "../utils/telemetry-utils.js"
import { buildContentFilter } from "../../srv/llm.js"

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

  describe("srv.agent.contentFilter (per-service override)", () => {
    let originalValue

    beforeEach(() => {
      originalValue = cds.env.agents.contentFilter
      cds.env.agents.contentFilter = true // global enabled
    })

    afterEach(() => {
      cds.env.agents.contentFilter = originalValue
    })

    it("should disable when srv.agent.contentFilter = false (overrides global true)", async () => {
      const srv = { agent: { contentFilter: false } }
      const result = await buildContentFilter(srv)

      expect(result).toBeUndefined()
    })

    it("should passthrough object from srv.agent.contentFilter", async () => {
      const custom = {
        input: { filters: [{ type: "my_filter", config: {} }] },
        output: { filters: [{ type: "my_output_filter", config: {} }] },
      }
      const srv = { agent: { contentFilter: custom } }
      const result = await buildContentFilter(srv)

      expect(result).toBe(custom)
    })

    it("should call async function and use its return value", async () => {
      const custom = {
        input: { filters: [{ type: "dynamic_filter" }] },
        output: { filters: [] },
      }
      const srv = { agent: { contentFilter: async () => custom } }
      const result = await buildContentFilter(srv)

      expect(result).toBe(custom)
    })

    it("should fall back to global config when srv.agent.contentFilter is undefined", async () => {
      const srv = { agent: {} }
      const result = await buildContentFilter(srv)

      // Global is true → Azure defaults
      expect(result.input.filters).toHaveLength(1)
      expect(result.input.filters[0]).toHaveProperty("type", "azure_content_safety")
    })

    it("should fall back to global config when srv.agent is undefined", async () => {
      const srv = {}
      const result = await buildContentFilter(srv)

      expect(result.input.filters).toHaveLength(1)
      expect(result.input.filters[0]).toHaveProperty("type", "azure_content_safety")
    })

    it("should fall back to global config when srv is undefined", async () => {
      const result = await buildContentFilter(undefined)

      expect(result.input.filters).toHaveLength(1)
      expect(result.input.filters[0]).toHaveProperty("type", "azure_content_safety")
    })
  })
})
