import cds from "@sap/cds"

const { POST } = cds.test(import.meta.dirname + "/../projects/deep-agent")

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

  it("injects AGENTS.md content and skills into the system prompt on the deep-agent path", async () => {
    const srv = await cds.connect.to("ProductAgentService")

    let handlerFired = false
    let capturedMessages = null
    srv.after("buildModel", (model) => {
      if (!model || model._captureInstalled) return
      handlerFired = true
      const originalGenerate = model._generate.bind(model)
      model._generate = async function (messages, ...args) {
        capturedMessages = messages
        return originalGenerate(messages, ...args)
      }
      model._captureInstalled = true
      return model
    })

    const res = await POST("/a2a/product-agent/", {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [{ kind: "text", text: "show me all products" }],
        },
      },
    })

    expect(res.data?.result?.status?.state).toBe("completed")

    expect(
      handlerFired,
      "srv.after('buildModel') never fired — graph may have been cached from an earlier test",
    ).toBe(true)
    expect(capturedMessages).not.toBe(null)
    const sysMsg = capturedMessages.find((m) => m._getType?.() === "system")
    expect(sysMsg).not.toBe(undefined)

    const sysText = Array.isArray(sysMsg.content)
      ? sysMsg.content.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n")
      : String(sysMsg.content)

    expect(sysText).toMatch(/ProductAgentService/)

    expect(sysText).toContain("You are the **Product Agent**")

    expect(sysText).toContain("Identity")
    expect(sysText).toContain("Core Behaviour")
    expect(sysText).toContain("Workflow Routing")

    expect(sysText).toContain("product-search")
    expect(sysText).toContain("order-management")
  })
})
