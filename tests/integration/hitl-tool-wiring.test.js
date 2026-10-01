import cds from "@sap/cds"

// Boot the bookshop test app — CatalogService.submitOrder is annotated @agent.hitl.
cds.test(import.meta.dirname + "/../projects/bookshop")

const { generateTools } = await import("../../srv/handlers/tools.js")
const { humanInTheLoopMiddleware } = await import("../../lib/agents/middleware/hitl.js")

// HITL is wired by matching tool.name against srv.actions[tool.name]["@agent.hitl"]
// (see lib/agents/middleware/hitl.js). That match only holds for per-action tools,
// whose name IS the action name ("submitOrder"). The generic combined action tool is
// named "call", which matches no action — so its presence silently drops HITL.
describe("@agent.hitl tool wiring (non-hybrid)", () => {
  const service = () => cds.services["CatalogService"]

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
  })

  it("installs HITL middleware for an @agent.hitl action under the default config", async () => {
    const srv = service()
    const tools = generateTools(srv)
    const middleware = await humanInTheLoopMiddleware(srv, tools)

    // Regression (PR #166): the default flipped to the generic "call" action tool,
    // whose name never matches srv.actions, so no HITL middleware is installed and
    // @agent.hitl is silently ignored.
    expect(middleware.length).toBeGreaterThan(0)
  })

  it("installs HITL middleware when per_action_tool is enabled (proves the cause)", async () => {
    const srv = service()
    const middleware = await withPerActionTool(true, async () => {
      const tools = generateTools(srv)
      expect(tools.map((t) => t.name)).toContain("submitOrder")
      return humanInTheLoopMiddleware(srv, tools)
    })
    expect(middleware.length).toBeGreaterThan(0)
  })
})
