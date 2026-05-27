const cds = require("@sap/cds")

const { POST, axios } = cds.test(__dirname + "/../bookshop")
const { sendMessage } = require("./helpers")({ POST, axios })

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

describe("@cap-js/a2a - Production error sanitization", () => {
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
        expect(res.data.error.message).toBe("Internal Server Error")
        expect(res.data.error.message).not.toContain("Internal error:")
        expect(res.data.error.code).toBe(-32603)
      }
    })

    it("should show error details in development", async () => {
      process.env.NODE_ENV = "development"

      const res = await POST("/a2a/graph-book/", { invalid: true })

      if (res.status === 500) {
        expect(res.data.error.message).toMatch(/^Internal error:/)
        expect(res.data.error.code).toBe(-32603)
      }
    })
  })

  describe("task failed status message (lib/executor/graph.js)", () => {
    it("should hide error details in production", async () => {
      process.env.NODE_ENV = "production"

      const originalMax = cds.env.a2a.pool.maxLLMInvocationsPerTask
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 1

      const res = await sendMessage("looping", "trigger")
      await wait()

      cds.env.a2a.pool.maxLLMInvocationsPerTask = originalMax

      if (res.data.result?.status?.state === "failed") {
        const msg = res.data.result.status.message.parts[0].text
        expect(msg).toBe("Internal Server Error")
        expect(msg).not.toContain("Agent error:")
      }
    })

    it("should show error details in development", async () => {
      process.env.NODE_ENV = "development"

      const originalMax = cds.env.a2a.pool.maxLLMInvocationsPerTask
      cds.env.a2a.pool.maxLLMInvocationsPerTask = 1

      const res = await sendMessage("looping", "trigger")
      await wait()

      cds.env.a2a.pool.maxLLMInvocationsPerTask = originalMax

      if (res.data.result?.status?.state === "failed") {
        const msg = res.data.result.status.message.parts[0].text
        expect(msg).toMatch(/^Agent error:/)
      }
    })
  })
})
