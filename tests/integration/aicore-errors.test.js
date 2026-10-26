import { OrchestrationClient } from "@sap-ai-sdk/langchain"
import { HumanMessage } from "@langchain/core/messages"
import InstrumentedOrchestrationClient from "../../lib/models/aicore.js"

describe("AI Core error diagnostics", () => {
  afterEach(() => vi.restoreAllMocks())

  const cases = [
    {
      name: "SDK errors with an upstream response",
      createError: () => {
        const rootCause = Object.assign(new Error("Request failed with status code 400"), {
          status: 400,
          response: { data: { error: { message: "Unsupported model parameter" } } },
        })
        return Object.assign(new Error("AI Core request failed", { cause: rootCause }), {
          rootCause,
        })
      },
    },
    {
      name: "plain streaming errors",
      createError: () => new Error("No chunks were generated from the stream."),
    },
  ]

  for (const { name, createError } of cases) {
    it(`preserves ${name} during generation`, async () => {
      const error = createError()
      const stack = error.stack
      vi.spyOn(OrchestrationClient.prototype, "_generate").mockRejectedValueOnce(error)
      const model = new InstrumentedOrchestrationClient("llm", {
        model: "test-model",
        contentFilter: false,
        streaming: false,
      })

      await expect(model.invoke([new HumanMessage("Hello")])).rejects.toBe(error)
      expect(error.stack).toBe(stack)
    })

    it(`preserves ${name} during streaming`, async () => {
      const error = createError()
      const stack = error.stack
      vi.spyOn(OrchestrationClient.prototype, "_streamResponseChunks").mockImplementationOnce(
        async function* () {
          yield await Promise.reject(error)
        },
      )
      const model = new InstrumentedOrchestrationClient("llm", {
        model: "test-model",
        contentFilter: false,
      })

      const stream = model._streamResponseChunks([new HumanMessage("Hello")], {})
      await expect(stream.next()).rejects.toBe(error)
      expect(error.stack).toBe(stack)
    })
  }
})
