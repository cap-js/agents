import cds from "@sap/cds"
import { vi } from "vitest"
import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { ChatGenerationChunk } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent, tool } from "langchain"
import { z } from "zod"
import Client from "../../lib/models/aicore.js"
import buildMiddleware from "../../lib/agents/middleware/index.js"
import * as utils from "../../lib/utils/utils.js"

const BLOCKED = "rejected-input-marker"
const sdkGenerate = OrchestrationClient.prototype._generate
const roles = { ai: "assistant", human: "user", tool: "tool", system: "system" }

// Mock only AI Core's filter/completion. Exercise real model preparation,
// middleware, agent execution, message reducers, and serialized checkpoints.
describe.each(["invoke", "auto-stream", "graph-stream"])(
  "content filter middleware (%s)",
  (mode) => {
    let requests
    let upstreamError
    let recoveryError

    beforeEach(() => {
      requests = []
      upstreamError = undefined
      recoveryError = undefined
      vi.spyOn(utils, "audit").mockImplementation(() => {})

      function completion(model, messages, options) {
        const config = model.mergeOrchestrationConfig(model.orchestrationConfig, options)
        const target = config.filtering.input.filters[0].target_selector?.after_last_role
        const boundary = target ? messages.findLastIndex((m) => roles[m._getType()] === target) : -1
        const selected = messages.slice(boundary + 1)
        requests.push({ messages, selected, target })
        if (upstreamError) throw upstreamError
        if (JSON.stringify(selected).includes(BLOCKED)) {
          throw filterError("Input Filtering Module")
        }
        if (messages.at(-1).text === "Trigger output filtering") {
          throw filterError("Output Filtering Module")
        }
        if (ToolMessage.isInstance(messages.at(-1)) && messages.at(-1).status === "error") {
          if (recoveryError) throw recoveryError
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "read_book",
                args: { id: 3 },
                id: "read-alternative-" + requests.length,
                type: "tool_call",
              },
            ],
          })
        }
        return messages.at(-1).text === "Read the books"
          ? new AIMessage({
              content: "",
              tool_calls: [1, 2].map((id) => ({
                name: "read_book",
                args: { id },
                id: `read-${id}`,
                type: "tool_call",
              })),
            })
          : new AIMessage("Accepted")
      }

      vi.spyOn(OrchestrationClient.prototype, "_generate").mockImplementation(
        function (messages, options, manager) {
          if (this.streaming) return sdkGenerate.call(this, messages, options, manager)
          const message = completion(this, messages, options)
          return Promise.resolve({ generations: [{ message, text: message.content }] })
        },
      )
      vi.spyOn(OrchestrationClient.prototype, "_streamResponseChunks").mockImplementation(
        async function* (messages, options) {
          const message = completion(this, messages, options)
          yield new ChatGenerationChunk({
            text: message.content,
            message: new AIMessageChunk({
              content: message.content,
              tool_calls: message.tool_calls,
            }),
          })
        },
      )
    })

    afterEach(() => vi.restoreAllMocks())

    async function makeAgent(
      tools = [],
      checkpointer = new MemorySaver(),
      systemPrompt = "Help with the catalog.",
    ) {
      const model = new Client("content-filter-test", {
        model: "anthropic--claude-4.6-sonnet",
        streaming: mode !== "invoke",
        flatten: true,
      })
      const srv = { name: "FilterRecoveryService", actions: {} }
      return createAgent({
        model,
        tools,
        systemPrompt,
        middleware: await buildMiddleware(srv, { model, tools }),
        checkpointer,
      })
    }

    async function run(agent, message, config) {
      const input = { messages: [message] }
      if (mode !== "graph-stream") return agent.invoke(input, config)
      const stream = await agent.stream(input, { ...config, streamMode: ["messages", "updates"] })
      for await (const _chunk of stream) {
        /* drain the graph as GraphExecutor does */
      }
      return (await agent.getState(config)).values
    }

    it.each([false, true])(
      "redacts rejected user input and accepts a follow-up (existing history: %s)",
      async (existingHistory) => {
        const agent = await makeAgent()
        const config = { configurable: { thread_id: cds.utils.uuid() } }
        if (existingHistory) await run(agent, new HumanMessage("Hello"), config)

        const refusal = await run(
          agent,
          new HumanMessage({
            id: "blocked-user",
            content: [{ type: "text", text: BLOCKED }],
            additional_kwargs: { raw: BLOCKED },
          }),
          config,
        )
        expect(refusal.messages.at(-1).text).toBe(cds.i18n.messages.at("CONTENT_FILTER_BLOCKED"))

        expect(requests).toHaveLength(existingHistory ? 2 : 1)
        expect(utils.audit).toHaveBeenCalledExactlyOnceWith("ContentFilterBlocked", {
          data: expect.objectContaining({ source: "user", reason: "Rejected test content" }),
        })
        const state = (await agent.getState(config)).values
        expect(JSON.stringify(state.messages)).not.toContain(BLOCKED)
        expect(state.messages.find((m) => m.id === "blocked-user")._getType()).toBe("human")
        if (existingHistory) expect(state.messages.some((m) => m.content === "Hello")).toBe(true)

        const result = await run(agent, new HumanMessage("How many books?"), config)
        expect(result.messages.at(-1).text).toBe("Accepted")
        expect(JSON.stringify(requests.at(-1).messages)).not.toContain(BLOCKED)
        expect(requests.at(-1).selected).toHaveLength(1)
        expect(requests.at(-1).selected[0].text).toBe("How many books?")
      },
    )

    it("filters and redacts the first input without a system prompt", async () => {
      const agent = await makeAgent([], new MemorySaver(), "")
      const config = { configurable: { thread_id: cds.utils.uuid() } }
      const refusal = await run(agent, new HumanMessage(BLOCKED), config)
      expect(refusal.messages.at(-1).text).toBe(cds.i18n.messages.at("CONTENT_FILTER_BLOCKED"))
      expect(requests[0].target).toBeUndefined()
      expect(requests[0].selected).toHaveLength(1)
      const state = (await agent.getState(config)).values
      expect(JSON.stringify(state.messages)).not.toContain(BLOCKED)
      const result = await run(agent, new HumanMessage("How many books?"), config)
      expect(result.messages.at(-1).text).toBe("Accepted")
      expect(JSON.stringify(requests.at(-1).messages)).not.toContain(BLOCKED)
    })

    it("lets the model choose another tool query after checkpointing rejected results", async () => {
      const read = vi.fn(async ({ id }) => [
        [{ type: "text", text: id === 1 ? BLOCKED : "safe book" }],
        { raw: id === 1 ? BLOCKED : "safe book" },
      ])
      const readBook = tool(read, {
        name: "read_book",
        description: "Read a book",
        schema: z.object({ id: z.number() }),
        responseFormat: "content_and_artifact",
      })
      const checkpointer = new MemorySaver()
      const agent = await makeAgent([readBook], checkpointer)
      const config = { configurable: { thread_id: cds.utils.uuid() } }
      await run(agent, new HumanMessage("Read the books"), config)

      expect(requests).toHaveLength(4)
      expect(read.mock.calls.map(([args]) => args.id)).toEqual([1, 2, 3])
      const retry = requests[2]
      expect(JSON.stringify(retry.messages)).not.toContain(BLOCKED)
      expect(retry.selected).toHaveLength(2)
      expect(retry.selected.every((m) => ToolMessage.isInstance(m) && m.status === "error")).toBe(
        true,
      )
      expect(
        retry.selected.every((m) =>
          /withheld.*content safety filter.*different query or source/i.test(m.text),
        ),
      ).toBe(true)
      // The model sees the tool failures without a synthetic assistant refusal in between.
      expect(retry.messages.filter(AIMessage.isInstance)).toHaveLength(1)
      expect(utils.audit).toHaveBeenCalledExactlyOnceWith("ContentFilterBlocked", {
        data: expect.objectContaining({ source: "tool", reason: "Rejected test content" }),
      })
      const state = (await agent.getState(config)).values
      expect(state.messages.at(-1).text).toBe("Accepted")
      expect(JSON.stringify(state.messages)).not.toContain(BLOCKED)
      const results = state.messages.filter(
        (m) => ToolMessage.isInstance(m) && m.status === "error",
      )
      expect(results.map((m) => m.tool_call_id).sort()).toEqual(["read-1", "read-2"])
      expect(results.every((m) => m.status === "error")).toBe(true)
      expect(results.every((m) => m.artifact === undefined)).toBe(true)

      // A fresh graph loading the same serialized checkpoint must also be safe.
      const reloaded = await makeAgent([readBook], checkpointer)
      const result = await run(reloaded, new HumanMessage("How many books?"), config)
      expect(result.messages.at(-1).text).toBe("Accepted")
      expect(JSON.stringify(requests.at(-1).messages)).not.toContain(BLOCKED)
    })

    it("keeps rejected tool results redacted if the continuation request fails", async () => {
      recoveryError = Object.assign(new Error("Continuation unavailable"), { status: 503 })
      const readBook = tool(async () => BLOCKED, {
        name: "read_book",
        description: "Read a book",
        schema: z.object({ id: z.number() }),
      })
      const agent = await makeAgent([readBook])
      const config = { configurable: { thread_id: cds.utils.uuid() } }
      await expect(run(agent, new HumanMessage("Read the books"), config)).rejects.toThrow(
        "Continuation unavailable",
      )
      expect(requests).toHaveLength(3)
      const state = (await agent.getState(config)).values
      expect(JSON.stringify(state.messages)).not.toContain(BLOCKED)
      expect(state.messages.at(-1).status).toBe("error")
      expect(
        state.messages
          .filter(ToolMessage.isInstance)
          .map((m) => m.tool_call_id)
          .sort(),
      ).toEqual(["read-1", "read-2"])
    })

    it("applies the existing model-call quota when alternative tool results keep being blocked", async () => {
      const readBook = tool(async () => BLOCKED, {
        name: "read_book",
        description: "Read a book",
        schema: z.object({ id: z.number() }),
      })
      const agent = await makeAgent([readBook])
      const config = { configurable: { thread_id: cds.utils.uuid() }, recursionLimit: 100 }
      const originalLimit = cds.env.agents.quotas.maxLLMInvocationsPerTask
      cds.env.agents.quotas.maxLLMInvocationsPerTask = 2
      try {
        await expect(run(agent, new HumanMessage("Read the books"), config)).rejects.toThrow(
          /LLM call limit exceeded/,
        )
        expect(requests).toHaveLength(5)
        const state = (await agent.getState(config)).values
        expect(JSON.stringify(state.messages)).not.toContain(BLOCKED)
      } finally {
        cds.env.agents.quotas.maxLLMInvocationsPerTask = originalLimit
      }
    })

    it("preserves user input when only output filtering rejects the response", async () => {
      const agent = await makeAgent()
      const config = { configurable: { thread_id: cds.utils.uuid() } }
      const refusal = await run(agent, new HumanMessage("Trigger output filtering"), config)
      expect(refusal.messages.at(-1).text).toBe(cds.i18n.messages.at("CONTENT_FILTER_BLOCKED"))
      expect(utils.audit).toHaveBeenCalledExactlyOnceWith("ContentFilterBlocked", {
        data: expect.objectContaining({ source: "model", reason: "Rejected test content" }),
      })
      const state = (await agent.getState(config)).values
      expect(state.messages[0].content).toBe("Trigger output filtering")
      const result = await run(agent, new HumanMessage("How many books?"), config)
      expect(result.messages.at(-1).text).toBe("Accepted")
    })

    it("propagates unrelated model errors without redacting the input", async () => {
      upstreamError = Object.assign(new Error("Upstream temporarily unavailable"), { status: 503 })
      const agent = await makeAgent()
      const config = { configurable: { thread_id: cds.utils.uuid() } }
      await expect(run(agent, new HumanMessage("How many books?"), config)).rejects.toThrow(
        "Upstream temporarily unavailable",
      )
      const state = (await agent.getState(config)).values
      expect(state.messages).toHaveLength(1)
      expect(state.messages[0].content).toBe("How many books?")
      expect(utils.audit).not.toHaveBeenCalled()
    })
  },
)

function filterError(location) {
  const cause = Object.assign(new Error("Request failed with status code 400"), {
    status: 400,
    response: { status: 400, data: { error: { location, message: "Rejected test content" } } },
  })
  return new Error("AI Core request failed", { cause })
}
