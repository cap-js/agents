import assert from "node:assert/strict"
import { describe, it } from "node:test"

const { GraphExecutor } = await import("../../lib/executor/graph.js")

const fakeEventBus = { publish: () => {}, finished: () => {} }

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

    assert.ok(capturedConfig, "graph.invoke must have been called")
    assert.strictEqual(
      capturedConfig.configurable.myKey,
      "injected-value",
      "configMapper return value must appear in config.configurable",
    )
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

    assert.notStrictEqual(capturedConfig.configurable.thread_id, "HACKER")
    assert.notStrictEqual(capturedConfig.configurable._taskId, "HACKER")
    assert.notStrictEqual(capturedConfig.configurable._service, "HACKER")
    assert.strictEqual(capturedConfig.configurable.safe, "allowed")
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

    assert.ok(capturedConfig?.configurable?.thread_id, "thread_id must be set")
    assert.ok(capturedConfig?.configurable?._taskId, "_taskId must be set")
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

    assert.strictEqual(
      capturedConfig.configurable.asyncKey,
      "async-value",
      "async configMapper value must be awaited and present in config.configurable",
    )
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
    assert.ok(failedEvent, "a failed status event must have been published")
    assert.match(
      failedEvent.status.message.parts[0].text,
      /configMapper must return a plain object/,
    )
  })
})
