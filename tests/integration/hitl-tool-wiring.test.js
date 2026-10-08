import cds from "@sap/cds"

// Boot the bookshop test app — CatalogService.submitOrder is annotated @agent.hitl,
// while getStock is a plain, non-gated function.
cds.test(import.meta.dirname + "/../projects/bookshop")

const { generateTools } = await import("../../srv/handlers/tools.js")
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
