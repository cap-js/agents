import cds from "@sap/cds"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { fakeModel } from "@langchain/core/testing"
import createHelpers from "../utils/helpers.js"

// Boot the bookshop test app — CatalogService.submitOrder is annotated @agent.hitl,
// while getStock is a plain, non-gated function.
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
const { sendMessage } = createHelpers({ POST, axios })

const { generateTools } = await import("../../lib/agents/tools.js")
const { buildHitlInterruptMap, humanInTheLoopMiddleware } =
  await import("../../lib/agents/middleware/hitl.js")

// HITL is wired by matching tool calls against srv.actions[...]["@agent.hitl"].
// Per-action tools carry the action name directly; the generic combined "call"
// tool (the default) fronts every action behind one name and must gate per-call
// via `when`, reading the requested action from args.action.
describe("@agent.hitl tool wiring (non-hybrid)", () => {
  const service = () => cds.services["CatalogService"]
  const callArgs = (action) => ({ toolCall: { args: { action } } })

  // Toggle generateTools' per-action vs generic decision without leaking env across tests.
  const withPerActionTool = async (value, fn) => {
    const prev = cds.env.mcp
    cds.env.mcp = { ...prev, per_action_tool: value }
    try {
      return await fn()
    } finally {
      cds.env.mcp = prev
    }
  }

  it("submitOrder carries the @agent.hitl annotation (model sanity)", () => {
    expect(service().actions.submitOrder?.["@agent.hitl"]).toBeTruthy()
    expect(service().actions.getStock?.["@agent.hitl"]).toBeFalsy()
  })

  it("installs HITL middleware for an @agent.hitl action under the default config", async () => {
    const srv = service()
    const middleware = await humanInTheLoopMiddleware(srv, generateTools(srv))
    expect(middleware.length).toBeGreaterThan(0)
  })

  it("adds approval guidance to a custom system prompt without changing it", async () => {
    const srv = service()
    const middleware = await humanInTheLoopMiddleware(srv, generateTools(srv))
    const request = { systemMessage: new SystemMessage("You manage book orders.") }
    const handler = vi.fn((request) => request)
    const result = await middleware[0].wrapModelCall(request, handler)
    expect(result.systemMessage.content).toContain("You manage book orders.")
    expect(result.systemMessage.content).toContain("Do not ask for a separate text confirmation.")
    expect(request.systemMessage.content).toBe("You manage book orders.")
  })

  it("generic 'call' tool gates per-action via when (interrupts submitOrder, not getStock)", () => {
    const srv = service()
    const tools = generateTools(srv)
    expect(tools.map((t) => t.name)).toContain("call")

    const interruptOn = buildHitlInterruptMap(srv, tools)
    // One entry — the combined tool — not a per-action key.
    expect(Object.keys(interruptOn)).toEqual(["call"])
    expect(interruptOn.call.when(callArgs("submitOrder"))).toBe(true)
    expect(interruptOn.call.when(callArgs("getStock"))).toBe(false)
  })

  it("adds no 'call' entry (and no middleware) when no action is @agent.hitl", async () => {
    // Synthetic service: has actions, but none annotated — the when-based entry
    // must not be installed, so the whole HITL middleware stays off.
    const srv = { actions: { getStock: {}, listBooks: {} } }
    const tools = [{ name: "call" }]
    expect(buildHitlInterruptMap(srv, tools)).toEqual({})
    expect(await humanInTheLoopMiddleware(srv, tools)).toEqual([])
  })

  it("does not execute submitOrder when its paused tool call is rejected", async () => {
    const srv = service()
    const model = fakeModel()
      .respondWithTools([
        { name: "call", args: { action: "submitOrder", parameters: { book: 201, quantity: 1 } } },
      ])
      .respond(new AIMessage("Order declined."))
    srv.prepend((s) => s.on("buildModel", () => model))
    const dispatch = vi.spyOn(srv, "send")

    try {
      const requested = await sendMessage("catalog", "Order one copy of book 201")
      const task = requested.data.result
      expect(task.status.state).toBe("input-required")

      const rejected = await sendMessage("catalog", "no", {
        contextId: task.contextId,
        taskId: task.id,
      })
      expect(rejected.data.result.status.state).toBe("completed")
      expect(dispatch).not.toHaveBeenCalledWith("submitOrder", expect.anything())
    } finally {
      dispatch.mockRestore()
    }
  })

  it("per-action tools gate by matching the action name directly", async () => {
    const srv = service()
    const interruptOn = await withPerActionTool(true, () => {
      const tools = generateTools(srv)
      expect(tools.map((t) => t.name)).toContain("submitOrder")
      return buildHitlInterruptMap(srv, tools)
    })
    expect(interruptOn.submitOrder).toBeDefined()
    expect(interruptOn.getStock).toBeUndefined()
  })
})
