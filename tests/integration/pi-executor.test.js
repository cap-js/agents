import { describe, expect, it, vi } from "vitest"
import z from "zod"
import { createModels } from "@earendil-works/pi-ai"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"

import PiModel from "../../lib/models/pi-generic.js"
import PiExecutor from "../../lib/protocol/pi-executor.js"
import { toPiTools } from "../../srv/handlers/tools.js"

describe("Pi executor", () => {
  it("adapts existing structured tools to the Pi tool contract", async () => {
    const invoke = vi.fn(async ({ title }) => `created ${title}`)
    const piTools = toPiTools([
      {
        name: "create_book",
        description: "Create a book",
        schema: z.object({ title: z.string() }),
        invoke,
      },
      { name: "secret", invoke, isAllowed: () => false },
    ])
    const [tool] = piTools

    expect(piTools).toHaveLength(1)
    expect(tool.parameters.type).toBe("object")
    expect(tool.parameters.properties.title.type).toBe("string")
    expect(await tool.execute("call-1", { title: "Dune" })).toEqual({
      content: [{ type: "text", text: "created Dune" }],
      details: {},
    })
    expect(invoke).toHaveBeenCalledWith({ title: "Dune" }, { signal: undefined })
  })

  it("configures a Pi model through pi-generic with a built-in provider", async () => {
    const llm = new PiModel("pi-test-llm", {
      kind: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        apiKey: "secret",
        url: "https://example.test",
      },
    })

    expect(llm.name).toBe("pi-test-llm")
    expect(llm.model).toMatchObject({ id: "claude-sonnet-4-6", baseUrl: "https://example.test" })
    expect(llm.getApiKey()).toBe("secret")
    expect(llm.streamFn).toBeTypeOf("function")
  })

  it("runs tools, streams, and completes an A2A task with the real Pi Agent", async () => {
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-test" }] })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { id: 7 })),
      fauxAssistantMessage("Hello from Pi"),
    ])
    const models = createModels()
    models.setProvider(faux.provider)

    const invoke = vi.fn(async ({ id }) => `found ${id}`)
    const piTools = toPiTools([
      {
        name: "lookup",
        description: "Look up an ID",
        schema: z.object({ id: z.number() }),
        invoke,
      },
    ])
    const srv = {
      name: "PiTestService",
      send: vi.fn(async (event) =>
        event === "buildModel"
          ? {
              model: models.getModel("anthropic", "claude-test"),
              streamFn: models.streamSimple.bind(models),
            }
          : event === "buildTools"
            ? piTools
            : "Be helpful",
      ),
    }

    const { default: create } = await import("../../lib/agents/pi.js")
    const { factory } = await create(srv)
    const executor = new PiExecutor(factory, srv)

    const events = []
    const eventBus = { publish: (event) => events.push(event), finished: vi.fn() }

    await executor.execute(
      {
        taskId: "task-1",
        contextId: "context-1",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
      },
      eventBus,
    )

    expect(events.some((e) => e.kind === "task" && e.status?.state === "working")).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: "task", status: { state: "completed" } })
    expect(invoke).toHaveBeenCalledWith(
      { id: 7 },
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(eventBus.finished).toHaveBeenCalledOnce()
  })
})
