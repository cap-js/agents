import cds from "@sap/cds"
import { AIMessage } from "@langchain/core/messages"

cds.test(import.meta.dirname + "/../projects/bookshop")

const { afterModelHook } = await import("../../lib/agents/middleware/status-update.js")

describe("tool-call data-part updates — generic call tool", () => {
  const emitFor = (toolCall, toolNames) => {
    const events = []
    const ctx = {
      model: cds.model,
      "agent.service": "CatalogService",
      "agent.task.id": "t1",
      "agent.context.id": "c1",
      "agent.request.metadata": { "tool-status-update": { args: true, result: true } },
      "agent.eventBus": { publish: (e) => events.push(e) },
    }
    const toolMeta = new Map(toolNames.map((n) => [n, {}]))
    cds._with(ctx, () => {
      const ai = new AIMessage({ content: "", tool_calls: [toolCall] })
      afterModelHook({ messages: [ai] }, toolMeta)
    })
    return events.find((e) => e.kind === "artifact-update")?.artifact?.parts?.[0]?.data
  }

  it("labels the generic 'call' tool by its args.action, not the tool name", () => {
    const data = emitFor(
      { id: "x1", name: "call", args: { action: "submitOrder", parameters: { book: 1 } } },
      ["call", "query", "describe"],
    )
    expect(data?.type).toBe("tool-call")
    expect(data.name).toBe("call")
    expect(data.label).toBe("submitOrder")
  })

  it("labels a per-action tool by its own name", () => {
    const data = emitFor(
      { id: "x2", name: "submitOrder", args: { book: 1, quantity: 2 } },
      ["submitOrder", "getStock", "query", "describe"],
    )
    expect(data?.type).toBe("tool-call")
    expect(data.name).toBe("submitOrder")
    expect(data.label).toBe("submitOrder")
  })
})
