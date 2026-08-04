import cds from "@sap/cds"

const { POST } = cds.test(import.meta.dirname + "/../samples/deep-agent")

describe("@cap-js/agents - deep agent graph construction events", () => {
  it("dispatches buildSystemPrompt when constructing the deep-agent graph", async () => {
    const srv = await cds.connect.to("ZeroCodeAgentService")

    const dispatchedEvents = []
    const originalSend = srv.send.bind(srv)
    srv.send = function (event, ...args) {
      dispatchedEvents.push(event)
      return originalSend(event, ...args)
    }

    try {
      const res = await POST("/a2a/zero-code-agent/", {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
      })

      expect(dispatchedEvents).toContain("buildTools")
      expect(dispatchedEvents).toContain("buildModel")
      expect(dispatchedEvents).toContain("buildSystemPrompt")
      expect(dispatchedEvents).toContain("buildMiddleware")

      expect(res.data?.jsonrpc).toBe("2.0")
      expect(res.data?.result?.status?.state).toBe("completed")
    } finally {
      srv.send = originalSend
    }
  })
})
