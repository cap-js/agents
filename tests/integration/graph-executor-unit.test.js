const { GraphExecutor, messageText, defaultOutputMapper } =
  await import("../../srv/handlers/graph-executor.js")

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
