import { createAgent, tool } from "../../lib/agents/runtime.js"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"

class Model extends BaseChatModel {
  constructor() {
    super({})
    this.calls = 0
  }
  _llmType() {
    return "runner-test"
  }
  bindTools() {
    return this
  }
  async _generate(messages) {
    this.calls++
    const message =
      messages.at(-1)._getType() === "tool"
        ? new AIMessage("Updated " + messages.at(-1).content)
        : new AIMessage({
            content: "",
            tool_calls: [{ id: "edit", name: "edit", args: { text: "source" } }],
          })
    return { generations: [{ text: message.content, message }] }
  }
}

test("Programmatic agents execute tools without requiring CDS persistence", async () => {
  const model = new Model()
  const edit = vi.fn(({ text }) => text.toUpperCase())
  const agent = await createAgent({
    model,
    tools: [
      tool(edit, {
        name: "edit",
        description: "Edit source",
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }),
    ],
    systemPrompt: "Edit the source",
    recursionLimit: 6,
  })
  const result = await agent.invoke({ messages: [new HumanMessage("Make a change")] })
  expect(result.messages.at(-1).content).toBe("Updated SOURCE")
  expect(edit).toHaveBeenCalledTimes(1)
  expect(model.calls).toBe(2)
})

test("Programmatic agents preserve caller checkpoints and enforce recursion limits", async () => {
  const checkpointer = new MemorySaver()
  const agent = await createAgent({
    model: new Model(),
    tools: [],
    checkpointer,
    recursionLimit: 1,
  })
  const config = { configurable: { thread_id: "edit-1" } }
  await expect(agent.invoke({ messages: [new HumanMessage("Edit")] }, config)).rejects.toThrow(
    /Recursion limit/,
  )
  expect((await agent.getState(config)).values.messages[0].content).toBe("Edit")
})
