import cds from "@sap/cds"
import { AIMessage } from "@langchain/core/messages"

// Boot the bookshop test app — CatalogService.submitOrder is a real action, so
// the model-driven label resolution has a definition to resolve against.
cds.test(import.meta.dirname + "/../projects/bookshop")

const { afterModelHook } = await import("../../lib/agents/middleware/status-update.js")

// The #149 tool-call observability events classify and label each call. The generic
// combined "call" tool fronts every action behind one tool name, carrying the target
// action in args.action — so the label must come from args.action, not the tool name.
// Guards that path (restored in #165) against regressing back to a bare "call" label.
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
    // The regression guard: label is derived from the requested action.
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
