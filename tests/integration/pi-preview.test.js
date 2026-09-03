import { describe, expect, it } from "vitest"
import cds from "@sap/cds"
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server"

import { createExecutor } from "../../lib/executor.js"
import preview from "../../lib/preview/preview.js"

describe("Pi chat preview", () => {
  it("renders chat.html and handles its message/send request through Pi", async () => {
    const router = preview("Pi Agent")
    const previewRoute = router.stack.find((layer) => layer.route?.path === "/")
    const previewHandler = previewRoute.route.stack[0].handle
    let html
    previewHandler(
      { originalUrl: "/a2a/catalog/preview/", headers: {} },
      {
        setHeader() {},
        send(body) {
          html = body
        },
      },
    )

    expect(html).toContain("<h1>Pi Agent</h1>")
    expect(html).toContain('method: useStream ? "message/stream" : "message/send"')

    const oldExecutor = cds.requires["agent-executor"]
    const oldLlm = cds.requires["pi-preview-llm"]
    cds.requires["agent-executor"] = { kind: "agent-executor-pi" }
    cds.requires["pi-preview-llm"] = {
      kind: "pi-mock",
      message: "Hello from Pi preview",
    }

    try {
      const srv = {
        name: "PiPreviewService",
        definition: { "@agent.llm": "pi-preview-llm" },
        send: async (event) => {
          if (event === "buildTools") return []
          if (event === "buildSystemPrompt") return "Be helpful"
          if (event === "buildModel") {
            const { default: Model } = await import("../../lib/models/pi-mock.js")
            return new Model("pi-preview-llm", cds.requires["pi-preview-llm"])
          }
        },
      }
      const executor = await createExecutor(srv)
      const card = {
        name: "Pi Agent",
        description: "Preview test",
        protocolVersion: "0.3.0",
        version: "1",
        url: "http://local/a2a/catalog",
        skills: [],
        capabilities: { streaming: true },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
      }
      const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
      const transport = new JsonRpcTransportHandler(handler)
      const response = await transport.handle({
        jsonrpc: "2.0",
        method: "message/send",
        id: "preview-test",
        params: {
          message: {
            kind: "message",
            role: "user",
            messageId: cds.utils.uuid(),
            parts: [{ kind: "text", text: "Hello from chat.html" }],
          },
        },
      })

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "preview-test",
        result: {
          status: {
            state: "completed",
            message: { parts: [{ text: "Hello from Pi preview" }] },
          },
        },
      })
    } finally {
      cds.requires["agent-executor"] = oldExecutor
      if (oldLlm === undefined) delete cds.requires["pi-preview-llm"]
      else cds.requires["pi-preview-llm"] = oldLlm
    }
  })
})
