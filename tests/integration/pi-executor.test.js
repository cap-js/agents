import { afterEach, describe, expect, it, vi } from "vitest"
import cds from "@sap/cds"
import z from "zod"
import { Agent } from "@earendil-works/pi-agent-core"
import { createModels } from "@earendil-works/pi-ai"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"

import PiExecutor, { configuredLlm, toPiTools } from "../../srv/pi-executor-srv.js"

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

  it("uses the same cds.requires model entry as the LangChain executor", () => {
    const previous = cds.requires["pi-test-llm"]
    cds.requires["pi-test-llm"] = {
      kind: "anthropic",
      model: "claude-test",
      credentials: { apiKey: "secret", url: "https://example.test" },
    }

    try {
      expect(
        configuredLlm({ definition: { "@agent.llm": "pi-test-llm" } }),
      ).toMatchObject({
        name: "pi-test-llm",
        provider: "anthropic",
        model: "claude-test",
        apiKey: "secret",
        baseUrl: "https://example.test",
      })
    } finally {
      if (previous === undefined) delete cds.requires["pi-test-llm"]
      else cds.requires["pi-test-llm"] = previous
    }
  })

  it("supports the existing development llm-mock kind", async () => {
    const previous = cds.requires["pi-test-mock"]
    cds.requires["pi-test-mock"] = { kind: "mock", message: "Pi mock response" }
    const srv = {
      name: "PiMockService",
      definition: { "@agent.llm": "pi-test-mock" },
      send: vi.fn(async (event) => (event === "buildTools" ? [] : "Be helpful")),
    }
    const events = []
    const eventBus = { publish: (event) => events.push(event), finished: vi.fn() }

    try {
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
    } finally {
      if (previous === undefined) delete cds.requires["pi-test-mock"]
      else cds.requires["pi-test-mock"] = previous
    }

    expect(events.at(-1)).toMatchObject({
      status: {
        state: "completed",
        message: { parts: [{ text: "Pi mock response" }] },
      },
      final: true,
    })
  })

  it("runs tools, streams, and completes an A2A task with the real Pi Agent", async () => {
    const previousLlm = cds.requires["pi-test-llm"]
    cds.requires["pi-test-llm"] = { kind: "anthropic", model: "claude-test" }

    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-test" }] })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { id: 7 })),
      fauxAssistantMessage("Hello from Pi"),
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    PiExecutor.runtime = async () => ({
      Agent,
      models,
    })

    const invoke = vi.fn(async ({ id }) => `found ${id}`)
    const srv = {
      name: "PiTestService",
      definition: { "@agent.llm": "pi-test-llm" },
      send: vi.fn(async (event) =>
        event === "buildTools"
          ? [{ name: "lookup", description: "Look up an ID", schema: z.object({ id: z.number() }), invoke }]
          : "Be helpful",
      ),
    }
    const events = []
    const eventBus = { publish: (event) => events.push(event), finished: vi.fn() }

    try {
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
    } finally {
      if (previousLlm === undefined) delete cds.requires["pi-test-llm"]
      else cds.requires["pi-test-llm"] = previousLlm
    }

    expect(events[0].kind).toBe("task")
    expect(events[1]).toMatchObject({ kind: "status-update", status: { state: "working" } })
    expect(events.some((event) => event.kind === "artifact-update")).toBe(true)
    expect(events.at(-1)).toMatchObject({ status: { state: "completed" }, final: true })
    expect(invoke).toHaveBeenCalledWith({ id: 7 }, expect.objectContaining({ signal: expect.anything() }))
    expect(eventBus.finished).toHaveBeenCalledOnce()
  })
})
