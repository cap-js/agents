import cds from "@sap/cds"
import { AIMessage } from "@langchain/core/messages"

cds.test(import.meta.dirname + "/../projects/bookshop")

const { afterModelHook, statusUpdateMiddleware } =
  await import("../../lib/agents/middleware/status-update.js")

describe("tool-call data-part updates — generic call tool", () => {
  const emitFor = async (toolCall, toolNames) => {
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
    await cds._with(ctx, () => {
      const ai = new AIMessage({ content: "", tool_calls: [toolCall] })
      afterModelHook({ messages: [ai] }, toolMeta)
    })
    return events.find((e) => e.kind === "artifact-update")?.artifact?.parts?.[0]?.data
  }

  it("labels the generic 'call' tool by its args.action, not the tool name", async () => {
    const data = await emitFor(
      { id: "x1", name: "call", args: { action: "submitOrder", parameters: { book: 1 } } },
      ["call", "query", "describe"],
    )
    expect(data?.type).toBe("tool-call")
    expect(data.name).toBe("call")
    expect(data.label).toBe("submitOrder")
  })

  it("labels a per-action tool by its own name", async () => {
    const data = await emitFor({ id: "x2", name: "submitOrder", args: { book: 1, quantity: 2 } }, [
      "submitOrder",
      "getStock",
      "query",
      "describe",
    ])
    expect(data?.type).toBe("tool-call")
    expect(data.name).toBe("submitOrder")
    expect(data.label).toBe("submitOrder")
  })

  it("keeps deep agent tool names separate from labels", async () => {
    const middleware = await statusUpdateMiddleware()
    const toolNames = ["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep"]

    for (const name of toolNames) {
      const events = []
      const ctx = {
        model: cds.model,
        "agent.service": "CatalogService",
        "agent.task.id": `deep-agent-${name}`,
        "agent.context.id": "c1",
        "agent.request.metadata": { "tool-status-update": {} },
        "agent.eventBus": { publish: (e) => events.push(e) },
      }
      await cds._with(ctx, async () => {
        const ai = new AIMessage({
          content: "",
          tool_calls: [{ id: `call-${name}`, name, args: {} }],
        })
        middleware.afterModel.hook({ messages: [ai] })
        await new Promise((resolve) => setImmediate(resolve))
      })

      const data = events.find((e) => e.kind === "artifact-update")?.artifact?.parts?.[0]?.data
      expect(data?.name).toBe(name)
      expect(data?.label).not.toBe(name)
    }
  })

  it("translates CatService getStock status and replaces its ValueList key with text", async () => {
    const events = []
    let resolveStatus
    const statusPublished = new Promise((resolve) => {
      resolveStatus = resolve
    })
    const ctx = {
      model: cds.model,
      "agent.service": "CatalogService",
      "agent.task.id": "t1",
      "agent.context.id": "c1",
      "agent.eventBus": {
        publish: (e) => {
          events.push(e)
          if (e.kind === "status-update") resolveStatus()
        },
      },
    }
    await cds._with(ctx, () => {
      const ai = new AIMessage({
        content: "",
        tool_calls: [
          { id: "x3", name: "call", args: { action: "getStock", parameters: { book: 201 } } },
        ],
      })
      afterModelHook({ messages: [ai] }, new Map([["call", {}]]))
    })
    await statusPublished

    expect(events.find((e) => e.kind === "status-update")?.status.message.parts[0].text).toBe(
      "Retrieving the stock for book Wuthering Heights (201)",
    )
  })
})
