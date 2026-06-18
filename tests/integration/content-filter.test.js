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
})
