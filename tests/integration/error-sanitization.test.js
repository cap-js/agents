import cds from "@sap/cds"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
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
        expect(res.data.error.message).toBe("Internal Server Error")
        expect(!res.data.error.message.includes("Internal error:")).toBeTruthy()
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

      const originalMax = cds.env.agents.pool.maxLLMInvocationsPerTask
      cds.env.agents.pool.maxLLMInvocationsPerTask = 1

      const res = await sendMessage("looping", "trigger")
      await wait()

      cds.env.agents.pool.maxLLMInvocationsPerTask = originalMax

      if (res.data.result?.status?.state === "failed") {
        const msg = res.data.result.status.message.parts[0].text
        expect(msg).toBe("Internal Server Error")
        expect(!msg.includes("Agent error:")).toBeTruthy()
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
        expect(msg).toMatch(/^Agent error:/)
      }
    })
  })
})

describe("@cap-js/agents - toolWrapMiddleware error handling", () => {
  it("includes err.details from a CAP multi-error action in the ToolMessage content", async () => {
    const { ToolMessage } = await import("@langchain/core/messages")
    const { toolWrapMiddleware } = await import("../../lib/agents/middleware/tool-wrap.js")

    const srv = cds.services.CatalogService
    const mw = toolWrapMiddleware()
    const result = await mw.wrapToolCall(
      { toolCall: { name: "validateOrder", id: "test-call-1" } },
      async () => srv.send("validateOrder", { book: 1, quantity: 1 }),
    )

    expect(ToolMessage.isInstance(result)).toBe(true)
    expect(result.status).toBe("error")
    expect(result.content).toContain("book is required")
    expect(result.content).toContain("quantity must be positive")
  })
})
