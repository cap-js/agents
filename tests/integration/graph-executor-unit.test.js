const {
  GraphExecutor,
  messageText,
  defaultOutputMapper,
  agentMessage,
  parseResumeDecision,
  decisionTypeOf,
  extractInterruptData,
} = await import("../../srv/handlers/graph-executor.js")
const { firstDataPart } = await import("../../lib/utils/message-handling.js")

const fakeEventBus = { publish: () => {}, finished: () => {} }

describe("messageText", () => {
  it("returns string content unchanged", () => {
    expect(messageText("hello")).toBe("hello")
  })

  it("joins text blocks from a content-block array, dropping non-text blocks", () => {
    const content = [
      { index: 0, type: "text", text: "Here are the books:" },
      { type: "tool_call", id: "t1", name: "f", args: {} },
      { index: 1, type: "text", text: " done." },
    ]
    expect(messageText(content)).toBe("Here are the books: done.")
  })

  it("returns empty string for null/undefined content", () => {
    expect(messageText(null)).toBe("")
    expect(messageText(undefined)).toBe("")
  })
})

describe("defaultOutputMapper", () => {
  it("extracts text from a last message with content-block array (no raw JSON leaks)", () => {
    const result = {
      messages: [{ content: [{ index: 0, type: "text", text: "The answer." }] }],
    }
    expect(defaultOutputMapper(result)).toBe("The answer.")
  })

  it("falls back to result.output when the last message has no text", () => {
    const result = {
      messages: [{ content: [{ type: "tool_call", id: "t1", name: "f", args: {} }] }],
      output: "from output field",
    }
    expect(defaultOutputMapper(result)).toBe("from output field")
  })
})

describe("GraphExecutor - configMapper", () => {
  it("calls configMapper and spreads result into config.configurable", async () => {
    let capturedConfig

    const fakeGraph = {
      checkpointer: {}, // prevent auto-injection of CdsCheckpointSaver
      invoke: async (_input, config) => {
        capturedConfig = config
        return { messages: [{ content: "ok" }] }
      },
    }

    const executor = new GraphExecutor(
      Promise.resolve(fakeGraph),
      { name: "TestService" },
      {
        configMapper: () => ({ myKey: "injected-value" }),
      },
    )

    await executor.execute(
      {
        taskId: "task-1",
        contextId: "ctx-1",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
        task: { status: { state: "working" } },
      },
      fakeEventBus,
    )

    expect(capturedConfig, "graph.invoke must have been called").toBeTruthy()
    expect(
      capturedConfig.configurable.myKey,
      "configMapper return value must appear in config.configurable",
    ).toBe("injected-value")
  })

  it("reserved keys (thread_id, _taskId, _service) take precedence over configMapper", async () => {
    let capturedConfig

    const fakeGraph = {
      checkpointer: {},
      invoke: async (_input, config) => {
        capturedConfig = config
        return { messages: [{ content: "ok" }] }
      },
    }

    // configMapper must not be able to overwrite reserved keys — they must always be spread last
    const executor = new GraphExecutor(
      Promise.resolve(fakeGraph),
      { name: "TestService" },
      {
        configMapper: () => ({
          thread_id: "HACKER",
          _taskId: "HACKER",
          _service: "HACKER",
          safe: "allowed",
        }),
      },
    )

    await executor.execute(
      {
        taskId: "task-2",
        contextId: "ctx-2",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
        task: { status: { state: "working" } },
      },
      fakeEventBus,
    )

    expect(capturedConfig.configurable.thread_id).not.toBe("HACKER")
    expect(capturedConfig.configurable._taskId).not.toBe("HACKER")
    expect(capturedConfig.configurable._service).not.toBe("HACKER")
    expect(capturedConfig.configurable.safe).toBe("allowed")
  })

  it("works without configMapper (no regression)", async () => {
    let capturedConfig

    const fakeGraph = {
      checkpointer: {},
      invoke: async (_input, config) => {
        capturedConfig = config
        return { messages: [{ content: "ok" }] }
      },
    }

    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

    await executor.execute(
      {
        taskId: "task-3",
        contextId: "ctx-3",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
        task: { status: { state: "working" } },
      },
      fakeEventBus,
    )

    expect(capturedConfig?.configurable?.thread_id, "thread_id must be set").toBeTruthy()
    expect(capturedConfig?.configurable?._taskId, "_taskId must be set").toBeTruthy()
  })

  it("async configMapper is awaited — its resolved values reach config.configurable", async () => {
    let capturedConfig

    const fakeGraph = {
      checkpointer: {},
      invoke: async (_input, config) => {
        capturedConfig = config
        return { messages: [{ content: "ok" }] }
      },
    }

    const executor = new GraphExecutor(
      Promise.resolve(fakeGraph),
      { name: "TestService" },
      {
        configMapper: async () => ({ asyncKey: "async-value" }),
      },
    )

    await executor.execute(
      {
        taskId: "task-4",
        contextId: "ctx-4",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
        task: { status: { state: "working" } },
      },
      fakeEventBus,
    )

    expect(
      capturedConfig.configurable.asyncKey,
      "async configMapper value must be awaited and present in config.configurable",
    ).toBe("async-value")
  })

  it("non-object return from configMapper fails the task with TypeError", async () => {
    let publishedEvents = []

    const fakeGraph = {
      checkpointer: {},
      invoke: async () => ({ messages: [{ content: "ok" }] }),
    }

    const capturingEventBus = {
      publish: (e) => publishedEvents.push(e),
      finished: () => {},
    }

    const executor = new GraphExecutor(
      Promise.resolve(fakeGraph),
      { name: "TestService" },
      {
        configMapper: () => "not-an-object",
      },
    )

    await executor.execute(
      {
        taskId: "task-5",
        contextId: "ctx-5",
        userMessage: { parts: [{ kind: "text", text: "hello" }] },
        task: { status: { state: "working" } },
      },
      capturingEventBus,
    )

    const failedEvent = publishedEvents.find((e) => e.status?.state === "failed")
    expect(failedEvent, "a failed status event must have been published").toBeTruthy()
    expect(failedEvent.status.message.parts[0].text).toMatch(
      /configMapper must return a plain object/,
    )
  })
})

describe("firstDataPart", () => {
  it("returns data from a v0.3 kind-based DataPart", () => {
    expect(firstDataPart([{ kind: "data", data: { a: 1 } }])).toEqual({ a: 1 })
  })

  it("returns value from a v1.0 oneOf DataPart", () => {
    expect(firstDataPart([{ content: { $case: "data", value: { a: 1 } } }])).toEqual({ a: 1 })
  })

  it("returns undefined for text-only parts", () => {
    expect(firstDataPart([{ kind: "text", text: "hi" }])).toBeUndefined()
  })

  it("returns undefined for empty/omitted parts", () => {
    expect(firstDataPart([])).toBeUndefined()
    expect(firstDataPart()).toBeUndefined()
  })

  it("returns the FIRST DataPart when several are present", () => {
    const parts = [
      { kind: "text", text: "hi" },
      { kind: "data", data: { first: true } },
      { kind: "data", data: { second: true } },
    ]
    expect(firstDataPart(parts)).toEqual({ first: true })
  })
})

describe("agentMessage", () => {
  it("emits a text-only message when no data is given", () => {
    const msg = agentMessage("hi")
    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0]).toMatchObject({ kind: "text", text: "hi" })
  })

  it("appends an opaque DataPart alongside the TextPart when data is a plain object", () => {
    const msg = agentMessage("hi", { decisions: [{ type: "approve" }] })
    expect(msg.parts).toHaveLength(2)
    expect(msg.parts[0]).toMatchObject({ kind: "text", text: "hi" })
    expect(msg.parts[1]).toEqual({ kind: "data", data: { decisions: [{ type: "approve" }] } })
  })

  it("stays text-only for string or null data (no DataPart)", () => {
    expect(agentMessage("hi", "str").parts).toHaveLength(1)
    expect(agentMessage("hi", null).parts).toHaveLength(1)
  })
})

describe("extractInterruptData", () => {
  it("returns the whole deepagents interrupt payload opaquely", () => {
    const payload = { actionRequests: [{ name: "submitOrder" }], reviewConfigs: [] }
    expect(extractInterruptData({ __interrupt__: [{ value: payload }] })).toBe(payload)
  })

  it("returns a raw object interrupt value", () => {
    const payload = { plan: ["a", "b"] }
    expect(extractInterruptData({ interrupts: [{ value: payload }] })).toBe(payload)
  })

  it("returns undefined for a string interrupt value", () => {
    expect(extractInterruptData({ __interrupt__: [{ value: "approve?" }] })).toBeUndefined()
  })

  it("returns undefined when no interrupt is present", () => {
    expect(extractInterruptData({})).toBeUndefined()
  })
})

describe("parseResumeDecision", () => {
  it("maps approve synonyms to an approve decision", () => {
    for (const t of ["approve", "yes", "confirm", "ok", "OK", " Approve "]) {
      expect(parseResumeDecision(t)).toEqual({ decisions: [{ type: "approve" }] })
    }
  })

  it("maps 'edit' to a distinct edit decision (not reject)", () => {
    expect(parseResumeDecision("edit")).toEqual({ decisions: [{ type: "edit" }] })
    expect(parseResumeDecision("EDIT")).toEqual({ decisions: [{ type: "edit" }] })
  })

  it("maps arbitrary text to a reject decision carrying the message", () => {
    expect(parseResumeDecision("no thanks")).toEqual({
      decisions: [{ type: "reject", message: "no thanks" }],
    })
  })
})

describe("decisionTypeOf", () => {
  it("reads the decision type from a text-path resume", () => {
    expect(decisionTypeOf({ decisions: [{ type: "approve" }] })).toBe("approve")
    expect(decisionTypeOf({ decisions: [{ type: "edit", args: {} }] })).toBe("edit")
  })

  it("falls back to 'data' for an opaque DataPart resume", () => {
    expect(decisionTypeOf({ foo: 1 })).toBe("data")
    expect(decisionTypeOf(undefined)).toBe("data")
  })
})

describe("GraphExecutor - HITL DataPart resume", () => {
  it("passes an inbound DataPart's data opaquely into Command({ resume })", async () => {
    let capturedInput

    const fakeGraph = {
      checkpointer: {},
      invoke: async (input) => {
        capturedInput = input
        return { messages: [{ content: "done" }] }
      },
    }

    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

    await executor.execute(
      {
        taskId: "task-hitl-1",
        contextId: "ctx-hitl-1",
        // DataPart-only resume (no TextPart) — must not throw, must reach Command
        userMessage: { parts: [{ kind: "data", data: { decisions: [{ type: "approve" }] } }] },
        task: { status: { state: "input-required" } },
      },
      fakeEventBus,
    )

    // Command instances carry the resume value on `.resume`
    expect(capturedInput?.resume).toEqual({ decisions: [{ type: "approve" }] })
  })

  it("falls back to text parsing when the resume carries no DataPart", async () => {
    let capturedInput

    const fakeGraph = {
      checkpointer: {},
      invoke: async (input) => {
        capturedInput = input
        return { messages: [{ content: "done" }] }
      },
    }

    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

    await executor.execute(
      {
        taskId: "task-hitl-2",
        contextId: "ctx-hitl-2",
        userMessage: { parts: [{ kind: "text", text: "approve" }] },
        task: { status: { state: "input-required" } },
      },
      fakeEventBus,
    )

    expect(capturedInput?.resume).toEqual({ decisions: [{ type: "approve" }] })
  })

  it("fails the task when a resume has neither text nor a DataPart", async () => {
    let publishedEvents = []

    const fakeGraph = {
      checkpointer: {},
      invoke: async () => ({ messages: [{ content: "done" }] }),
    }

    const capturingEventBus = {
      publish: (e) => publishedEvents.push(e),
      finished: () => {},
    }

    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

    await executor.execute(
      {
        taskId: "task-hitl-3",
        contextId: "ctx-hitl-3",
        userMessage: { parts: [] },
        task: { status: { state: "input-required" } },
      },
      capturingEventBus,
    )

    const failedEvent = publishedEvents.find((e) => e.status?.state === "failed")
    expect(failedEvent, "a failed status event must have been published").toBeTruthy()
    expect(failedEvent.status.message.parts[0].text).toMatch(/must contain text .* or a data part/)
  })
})

describe("GraphExecutor - HITL suspend carries a DataPart", () => {
  it("attaches the structured interrupt payload as a DataPart beside the TextPart", async () => {
    let publishedEvents = []

    const payload = { actionRequests: [{ name: "submitOrder", description: "Approve order?" }] }
    const fakeGraph = {
      checkpointer: {},
      invoke: async () => ({ __interrupt__: [{ value: payload }] }),
    }

    const capturingEventBus = {
      publish: (e) => publishedEvents.push(e),
      finished: () => {},
    }

    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

    await executor.execute(
      {
        taskId: "task-suspend-1",
        contextId: "ctx-suspend-1",
        userMessage: { parts: [{ kind: "text", text: "buy the book" }] },
        task: { status: { state: "working" } },
      },
      capturingEventBus,
    )

    const inputRequired = publishedEvents.find((e) => e.status?.state === "input-required")
    expect(inputRequired, "an input-required event must have been published").toBeTruthy()
    const parts = inputRequired.status.message.parts
    expect(parts.find((p) => p.kind === "text")?.text).toBe("Approve order?")
    expect(parts.find((p) => p.kind === "data")?.data).toEqual(payload)
  })
})
