import assert from "node:assert/strict"
import cds from "@sap/cds"

const { GraphExecutor } = await import("../../srv/handlers/graph-executor.js")

/** Mimics real LangGraph abort behavior — throws DOMException with name "AbortError" */
function abortError() {
  return new DOMException("The operation was aborted", "AbortError")
}

describe("GraphExecutor - abort/cancellation", () => {
  const withCtx = (fn) => () => cds._with({}, fn)

  it(
    "passes signal to graph.invoke via config",
    withCtx(async () => {
      let capturedConfig
      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          capturedConfig = config
          return { messages: [{ content: "ok" }] }
        },
      }
      const fakeEventBus = { publish: () => {}, finished: () => {} }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-signal-1",
          contextId: "ctx-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      assert.ok(capturedConfig.signal, "signal must be passed to graph.invoke config")
      assert.ok(capturedConfig.signal instanceof AbortSignal, "signal must be an AbortSignal")
      assert.strictEqual(capturedConfig.signal.aborted, false, "signal should not be aborted yet")
    }),
  )

  it(
    "abort(taskId) causes execute to publish canceled status",
    withCtx(async () => {
      const publishedEvents = []
      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          // Simulate long-running graph that respects abort signal
          return new Promise((resolve, reject) => {
            config.signal.addEventListener("abort", () => {
              reject(abortError())
            })
          })
        },
      }
      const fakeEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      const executePromise = executor.execute(
        {
          taskId: "task-abort-1",
          contextId: "ctx-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      // Let execute() start and register controller
      await new Promise((r) => setTimeout(r, 50))

      // Abort the task
      executor.abort("task-abort-1")

      await executePromise

      const canceledEvent = publishedEvents.find((e) => e.status?.state === "canceled")
      assert.ok(canceledEvent, "a canceled status event must have been published")
      // Should NOT have a failed event
      const failedEvent = publishedEvents.find((e) => e.status?.state === "failed")
      assert.strictEqual(failedEvent, undefined, "no failed event should be published on abort")
    }),
  )

  it("abort(taskId) is safe to call for unknown taskId", () => {
    const fakeGraph = { checkpointer: {}, invoke: async () => ({}) }
    const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

    // Should not throw
    executor.abort("non-existent-task")
  })

  it(
    "abort(taskId) is idempotent — calling twice does not throw",
    withCtx(async () => {
      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          return new Promise((resolve, reject) => {
            config.signal.addEventListener("abort", () => {
              reject(abortError())
            })
          })
        },
      }
      const fakeEventBus = { publish: () => {}, finished: () => {} }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      const executePromise = executor.execute(
        {
          taskId: "task-abort-2",
          contextId: "ctx-2",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      await new Promise((r) => setTimeout(r, 50))

      executor.abort("task-abort-2")
      executor.abort("task-abort-2") // second call — should not throw

      await executePromise
    }),
  )

  it(
    "cancelTask aborts running execution",
    withCtx(async () => {
      const publishedEvents = []
      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          return new Promise((resolve, reject) => {
            config.signal.addEventListener("abort", () => {
              reject(abortError())
            })
          })
        },
      }
      const fakeEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      const executePromise = executor.execute(
        {
          taskId: "task-cancel-1",
          contextId: "ctx-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      await new Promise((r) => setTimeout(r, 50))

      // cancelTask triggers abort internally
      await executor.cancelTask("task-cancel-1", fakeEventBus)

      await executePromise

      // cancelTask publishes its own canceled event + execute() catch publishes one too
      const canceledEvents = publishedEvents.filter((e) => e.status?.state === "canceled")
      assert.ok(canceledEvents.length >= 1, "at least one canceled status event expected")
    }),
  )

  it(
    "abortController is cleaned up after execution completes",
    withCtx(async () => {
      const fakeGraph = {
        checkpointer: {},
        invoke: async () => ({ messages: [{ content: "done" }] }),
      }
      const fakeEventBus = { publish: () => {}, finished: () => {} }

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-cleanup-1",
          contextId: "ctx-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      // Internal map should be clean
      assert.strictEqual(
        executor._abortControllers.size,
        0,
        "abortController should be removed after execution",
      )
    }),
  )

  it(
    "signal is already aborted if abort() called before graph.invoke starts",
    withCtx(async () => {
      const fakeGraph = {
        checkpointer: {},
        invoke: async (_input, config) => {
          if (config.signal.aborted) {
            throw abortError()
          }
          return { messages: [{ content: "ok" }] }
        },
      }
      const publishedEvents = []
      const fakeEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      const executor = new GraphExecutor(
        // Delay graph resolution to give us time to abort
        new Promise((resolve) => setTimeout(() => resolve(fakeGraph), 100)),
        { name: "TestService" },
        {},
      )

      const executePromise = executor.execute(
        {
          taskId: "task-preabort-1",
          contextId: "ctx-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      // Abort immediately — before graph resolves
      executor.abort("task-preabort-1")

      await executePromise

      // Graph should see aborted signal (or never run at all)
      const canceledEvent = publishedEvents.find((e) => e.status?.state === "canceled")
      assert.ok(canceledEvent, "should publish canceled when aborted before invoke")
    }),
  )
})

describe("GraphExecutor - graceful timeout", () => {
  const withCtx = (fn) => () => cds._with({}, fn)

  it(
    "timeout publishes canceled with summary (falls back when no checkpointer)",
    { timeout: 5000 },
    withCtx(async () => {
      const publishedEvents = []
      // Simulate a graph that runs longer than timeout
      const fakeGraph = {
        checkpointer: {}, // prevent auto-injection of CdsCheckpointSaver
        invoke: async (_input, config) => {
          // Block until signal aborts
          return new Promise((resolve, reject) => {
            config.signal.addEventListener("abort", () => {
              reject(abortError())
            })
          })
        },
      }
      const fakeEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      // Use very short timeout for test speed
      cds.env.agents = cds.env.agents || {}
      cds.env.agents.pool = cds.env.agents.pool || {}
      cds.env.agents.pool.maxExecutionTimePerTask = 200
      cds.env.agents.pool.timeoutGrace = 100

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      await executor.execute(
        {
          taskId: "task-timeout-1",
          contextId: "ctx-timeout-1",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      // Let cds.spawn (usage update in finally) settle
      await new Promise((r) => setTimeout(r, 50))

      // Restore
      cds.env.agents.pool.maxExecutionTimePerTask = "5min"
      cds.env.agents.pool.timeoutGrace = "15s"

      const canceledEvent = publishedEvents.find((e) => e.status?.state === "canceled")
      assert.ok(canceledEvent, "timeout should publish canceled status")
      assert.ok(
        canceledEvent.status.message.parts[0].text.includes("timed out"),
        "canceled message should mention timeout",
      )
      // Should NOT have a failed event
      const failedEvent = publishedEvents.find((e) => e.status?.state === "failed")
      assert.strictEqual(failedEvent, undefined, "timeout should not produce failed event")
    }),
  )

  it(
    "timeout with checkpointer calls _summarizeOnTimeout",
    { timeout: 5000 },
    withCtx(async () => {
      const publishedEvents = []
      const fakeCheckpointer = {
        getTuple: async () => ({
          checkpoint: {
            channel_values: {
              messages: [
                { _getType: () => "human", content: "Find me flights to Paris" },
                {
                  _getType: () => "ai",
                  content: "I found 3 flights to Paris. Let me check prices...",
                },
              ],
            },
          },
        }),
      }
      const fakeGraph = {
        checkpointer: fakeCheckpointer,
        invoke: async (_input, config) => {
          return new Promise((resolve, reject) => {
            config.signal.addEventListener("abort", () => {
              reject(abortError())
            })
          })
        },
      }
      const fakeEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      cds.env.agents = cds.env.agents || {}
      cds.env.agents.pool = cds.env.agents.pool || {}
      cds.env.agents.pool.maxExecutionTimePerTask = 200
      cds.env.agents.pool.timeoutGrace = 100

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})
      // Inject resolved graph directly so checkpointer is accessible
      executor._graph = fakeGraph

      await executor.execute(
        {
          taskId: "task-timeout-2",
          contextId: "ctx-timeout-2",
          userMessage: { parts: [{ kind: "text", text: "find flights" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )

      // Let cds.spawn (usage update in finally) settle
      await new Promise((r) => setTimeout(r, 50))

      // Restore
      cds.env.agents.pool.maxExecutionTimePerTask = "5min"
      cds.env.agents.pool.timeoutGrace = "15s"

      const canceledEvent = publishedEvents.find((e) => e.status?.state === "canceled")
      assert.ok(canceledEvent, "timeout with checkpointer should publish canceled status")
      // The summary either comes from LLM (if createModel works) or fallback
      const msg = canceledEvent.status.message.parts[0].text
      assert.ok(
        msg.includes("timed out") || msg.includes("Progress summary"),
        `canceled message should reference timeout or progress, got: "${msg}"`,
      )
    }),
  )

  it(
    "timeoutGrace is configurable",
    { timeout: 5000 },
    withCtx(async () => {
      const publishedEvents = []
      let invokeTime
      const fakeGraph = {
        checkpointer: {}, // prevent auto-injection of CdsCheckpointSaver
        invoke: async (_input, config) => {
          invokeTime = Date.now()
          return new Promise((resolve, reject) => {
            config.signal.addEventListener("abort", () => {
              reject(abortError())
            })
          })
        },
      }
      const fakeEventBus = {
        publish: (e) => publishedEvents.push(e),
        finished: () => {},
      }

      cds.env.agents = cds.env.agents || {}
      cds.env.agents.pool = cds.env.agents.pool || {}
      // 2000ms total, 200ms grace → soft timeout at 1800ms
      // (must be > 1000ms floor in _invokeWithTimeout)
      cds.env.agents.pool.maxExecutionTimePerTask = 2000
      cds.env.agents.pool.timeoutGrace = 200

      const executor = new GraphExecutor(Promise.resolve(fakeGraph), { name: "TestService" }, {})

      const t0 = Date.now()
      await executor.execute(
        {
          taskId: "task-timeout-3",
          contextId: "ctx-timeout-3",
          userMessage: { parts: [{ kind: "text", text: "hello" }] },
          task: { status: { state: "working" } },
        },
        fakeEventBus,
      )
      const elapsed = Date.now() - t0

      // Let cds.spawn (usage update in finally) settle
      await new Promise((r) => setTimeout(r, 50))

      // Restore
      cds.env.agents.pool.maxExecutionTimePerTask = "5min"
      cds.env.agents.pool.timeoutGrace = "15s"

      // Should timeout around 1800ms (2000 - 200 grace), not 2000ms
      assert.ok(elapsed < 1950, `should timeout before hard limit, elapsed: ${elapsed}ms`)
      assert.ok(elapsed >= 1700, `should not timeout too early, elapsed: ${elapsed}ms`)
    }),
  )
})
