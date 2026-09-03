import { afterEach, describe, expect, it, vi } from "vitest"
import z from "zod"
import { Agent } from "@earendil-works/pi-agent-core"
import { createModels } from "@earendil-works/pi-ai"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"

import PiAnthropicService from "../../lib/models/pi-anthropic.js"
import PiExecutor, { toPiTools } from "../../srv/pi-executor-srv.js"

const originalRuntime = PiExecutor.runtime

afterEach(() => {
  PiExecutor.runtime = originalRuntime
})

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

  it("configures the Pi Anthropic model through a model service", async () => {
    const llm = new PiAnthropicService("pi-test-llm", {
      model: "claude-sonnet-4-6",
      credentials: {
        apiKey: "secret",
        url: "https://example.test",
        headers: { "x-test": "configured" },
      },
    })

    expect(llm.name).toBe("pi-test-llm")
    expect(llm.model).toMatchObject({
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      baseUrl: llm.options.anthropicApiUrl || "https://example.test",
      headers: { "x-test": "configured" },
    })
    expect(await llm.getApiKey()).toBe(llm.options.apiKey)
    expect(llm.streamFn).toBeTypeOf("function")
  })

  it("uses the model runtime returned by buildModel", async () => {
    const faux = fauxProvider({ provider: "mock", models: [{ id: "mock" }] })
    const response = () => {
      faux.appendResponses([response])
      return fauxAssistantMessage("Pi mock response")
    }
    faux.setResponses([response])
    const models = createModels()
    models.setProvider(faux.provider)
    const srv = {
      name: "PiMockService",
      send: vi.fn(async (event) =>
        event === "buildModel"
          ? { model: models.getModel("mock", "mock"), streamFn: models.streamSimple.bind(models) }
          : event === "buildTools"
            ? []
            : "Be helpful",
      ),
    }
    const events = []
    const eventBus = { publish: (event) => events.push(event), finished: vi.fn() }

    await new PiExecutor().execute(
      srv,
      {},
      {
        taskId: "mock-task",
        contextId: "mock-context",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
      },
      eventBus,
    )

    expect(events.at(-1)).toMatchObject({
      status: {
        state: "completed",
        message: { parts: [{ text: "Pi mock response" }] },
      },
      final: true,
    })
  })

  it("runs tools, streams, and completes an A2A task with the real Pi Agent", async () => {
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-test" }] })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { id: 7 })),
      fauxAssistantMessage("Hello from Pi"),
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    PiExecutor.runtime = async () => ({ Agent })

    const invoke = vi.fn(async ({ id }) => `found ${id}`)
    const srv = {
      name: "PiTestService",
      send: vi.fn(async (event) =>
        event === "buildModel"
          ? {
              model: models.getModel("anthropic", "claude-test"),
              streamFn: models.streamSimple.bind(models),
            }
          : event === "buildTools"
            ? [
                {
                  name: "lookup",
                  description: "Look up an ID",
                  schema: z.object({ id: z.number() }),
                  invoke,
                },
              ]
            : "Be helpful",
      ),
    }
    const events = []
    const eventBus = { publish: (event) => events.push(event), finished: vi.fn() }

    await new PiExecutor().execute(
      srv,
      {},
      {
        taskId: "task-1",
        contextId: "context-1",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
      },
      eventBus,
    )

    expect(events[0].kind).toBe("task")
    expect(events[1]).toMatchObject({ kind: "status-update", status: { state: "working" } })
    expect(events.some((event) => event.kind === "artifact-update")).toBe(true)
    expect(events.at(-1)).toMatchObject({ status: { state: "completed" }, final: true })
    expect(invoke).toHaveBeenCalledWith(
      { id: 7 },
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(eventBus.finished).toHaveBeenCalledOnce()
  })
})
