import assert from "node:assert/strict"
import cds from "@sap/cds"

const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { sendMessage } = createHelpers({ POST, axios })

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

describe("@cap-js/agents - Production error sanitization", () => {
  let originalNodeEnv

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  describe("JSON-RPC 500 responses (lib/index.js)", () => {
    it("should hide error details in production", async () => {
      process.env.NODE_ENV = "production"

      // Send malformed body to trigger internal error in transport handler
      const res = await POST("/a2a/graph-book/", { invalid: true })

      if (res.status === 500) {
        assert.strictEqual(res.data.error.message, "Internal Server Error")
        assert.ok(!res.data.error.message.includes("Internal error:"))
        assert.strictEqual(res.data.error.code, -32603)
      }
    })

    it("should show error details in development", async () => {
      process.env.NODE_ENV = "development"

      const res = await POST("/a2a/graph-book/", { invalid: true })

      if (res.status === 500) {
        assert.match(res.data.error.message, /^Internal error:/)
        assert.strictEqual(res.data.error.code, -32603)
      }
    })
  })

  describe("task failed status message (lib/executor/graph.js)", () => {
    it("should hide error details in production", async () => {
      process.env.NODE_ENV = "production"

      const originalMax = cds.env.agents.pool.maxLLMInvocationsPerTask
      cds.env.agents.pool.maxLLMInvocationsPerTask = 1

      const res = await sendMessage("looping", "trigger")
      await wait()

      cds.env.agents.pool.maxLLMInvocationsPerTask = originalMax

      if (res.data.result?.status?.state === "failed") {
        const msg = res.data.result.status.message.parts[0].text
        assert.strictEqual(msg, "Internal Server Error")
        assert.ok(!msg.includes("Agent error:"))
      }
    })

    it("should show error details in development", async () => {
      process.env.NODE_ENV = "development"

      const originalMax = cds.env.agents.pool.maxLLMInvocationsPerTask
      cds.env.agents.pool.maxLLMInvocationsPerTask = 1

      const res = await sendMessage("looping", "trigger")
      await wait()

      cds.env.agents.pool.maxLLMInvocationsPerTask = originalMax

      if (res.data.result?.status?.state === "failed") {
        const msg = res.data.result.status.message.parts[0].text
        assert.match(msg, /^Agent error:/)
      }
    })
  })
})
