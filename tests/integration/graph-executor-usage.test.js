import cds from "@sap/cds"
import { AIMessage, AIMessageChunk } from "@langchain/core/messages"
import { ChatGenerationChunk } from "@langchain/core/outputs"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { GraphExecutor } from "../../srv/handlers/graph-executor.js"
import { createMockGraph } from "../utils/mock-streaming-graph.js"

const originalSpawn = cds.spawn

describe("GraphExecutor - task-local token usage", () => {
  let backgroundWork
  let recordedUsage

  beforeEach(() => {
    backgroundWork = []
    recordedUsage = new Map()
    cds.spawn = (fn) => {
      if (typeof fn === "function") backgroundWork.push(Promise.resolve().then(fn))
    }
    vi.stubGlobal("UPDATE", () => ({
      where: ({ taskId }) => ({
        with: ({ usageLlmTokens }) => {
          if (usageLlmTokens == null) return
          const previous = recordedUsage.get(taskId) ?? 0
          recordedUsage.set(
            taskId,
            typeof usageLlmTokens === "number" ? usageLlmTokens : previous + usageLlmTokens["+="],
          )
        },
      }),
    }))
  })

  afterEach(async () => {
    await Promise.all(backgroundWork)
    cds.spawn = originalSpawn
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function createModel(usage) {
    const model = new FakeChatModel({})
    vi.spyOn(model, "_generate").mockImplementation(async () => ({
      generations: [
        { text: "done", message: new AIMessage({ content: "done", usage_metadata: usage() }) },
      ],
    }))
    return model
  }

  async function run(executor, taskId, task = { status: { state: "working" } }) {
    const events = []
    await cds._with({}, () =>
      executor.execute(
        {
          taskId,
          contextId: "usage-conversation",
          userMessage: {
            parts:
              task.status.state === "input-required"
                ? [{ kind: "data", data: { decisions: [{ type: "approve" }] } }]
                : [{ kind: "text", text: "hello" }],
          },
          task,
        },
        { publish: (event) => events.push(event), finished() {} },
      ),
    )
    await Promise.all(backgroundWork)
    return events.find((event) => event.final)
  }

  it("counts only new model calls while retaining full conversation history", async () => {
    const usages = [
      { input_tokens: 10_000, output_tokens: 2_000, total_tokens: 12_000 },
      { input_tokens: 13_000, output_tokens: 2_000, total_tokens: 15_000 },
    ]
    const model = createModel(() => usages.shift())
    const history = []
    const graph = createMockGraph(async (input, config) => {
      history.push(...input.messages, await model.invoke(input.messages, config))
      return { messages: [...history] }
    })
    const executor = new GraphExecutor(graph, { name: "TestService" })

    await run(executor, "usage-first")
    const completed = await run(executor, "usage-second")

    expect(history).toHaveLength(4)
    expect(recordedUsage.get("usage-first")).toBe(12_000)
    expect(recordedUsage.get("usage-second")).toBe(15_000)
    expect(completed.metadata["sap.cds.agents.token-usage"].total_tokens).toBe(15_000)
  })

  it("accumulates resumed task usage without adding cache tokens a second time", async () => {
    const usage = {
      input_tokens: 9_550,
      output_tokens: 10,
      total_tokens: 9_560,
      input_token_details: { cache_creation: 1_500, cache_read: 8_000 },
    }
    const model = createModel(() => usage)
    const history = []
    let interrupted = false
    const graph = createMockGraph(async (_input, config) => {
      history.push(await model.invoke("hello", config))
      if (!interrupted) {
        interrupted = true
        return {
          messages: [...history],
          __interrupt__: [{ value: { actionRequests: [{ name: "example" }] } }],
        }
      }
      return { messages: [...history] }
    })

    const executor = new GraphExecutor(graph, { name: "TestService" })

    const suspended = await run(executor, "usage-resumed")
    expect(recordedUsage.get("usage-resumed")).toBe(9_560)
    const completed = await run(executor, "usage-resumed", {
      status: suspended.status,
    })

    expect(completed.status.state).toBe("completed")
    expect(recordedUsage.get("usage-resumed")).toBe(19_120)
    expect(completed.metadata["sap.cds.agents.token-usage"]).toMatchObject({
      total_tokens: 9_560,
      cache_creation_input_tokens: 1_500,
      cache_read_input_tokens: 8_000,
    })
  })

  it("counts streamed model calls even when the graph removes their messages", async () => {
    const model = new FakeChatModel({})
    vi.spyOn(model, "_streamResponseChunks").mockImplementation(async function* () {
      yield new ChatGenerationChunk({
        text: "done",
        message: new AIMessageChunk({
          content: "done",
          usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        }),
      })
    })
    const graph = createMockGraph(async (_input, config) => {
      const chunks = []
      const stream = await model.stream("hello", config)
      for await (const chunk of stream) chunks.push(chunk)
      return { messages: [{ content: "compacted history" }] }
    })
    const executor = new GraphExecutor(graph, { name: "TestService" })

    const completed = await run(executor, "usage-streamed")

    expect(recordedUsage.get("usage-streamed")).toBe(110)
    expect(completed.metadata["sap.cds.agents.token-usage"].total_tokens).toBe(110)
  })

  it.each([false, true])(
    "does not recharge checkpoint history after failure (new model call: %s)",
    async (callModel) => {
      const history = [
        {
          content: "previous answer",
          usage_metadata: { input_tokens: 10_000, output_tokens: 2_000, total_tokens: 12_000 },
        },
      ]
      const model = createModel(() => ({
        input_tokens: 1_000,
        output_tokens: 100,
        total_tokens: 1_100,
      }))
      const graph = createMockGraph(
        async (_input, config) => {
          if (callModel) history.push(await model.invoke("hello", config))
          throw new Error("synthetic execution failure")
        },
        { getTuple: async () => ({ checkpoint: { channel_values: { messages: history } } }) },
      )
      const executor = new GraphExecutor(graph, { name: "TestService" })

      const failed = await run(executor, "usage-failed")

      expect(failed.status.state).toBe("failed")
      expect(recordedUsage.get("usage-failed") ?? 0).toBe(callModel ? 1_100 : 0)
    },
  )
})
