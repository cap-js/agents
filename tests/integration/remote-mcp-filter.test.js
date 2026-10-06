/**
 * Unit-style tests for the mcp.tools filter in remoteMcpMiddleware.
 *
 * Mocks MultiServerMCPClient so no real MCP server is needed.
 */
import cds from "@sap/cds"
import { vi, describe, it, expect, beforeEach } from "vitest"

// ── Mock MultiServerMCPClient before importing the middleware ─────────────────

const mockGetTools = vi.fn()
vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: vi.fn().mockImplementation(function () {
    this.getTools = mockGetTools
  }),
}))

const { remoteMcpMiddleware } = await import("../../lib/agents/middleware/remote-mcp.js")

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMcpConfig(toolFilter) {
  return {
    _mcpDynamic: true,
    mcpUrl: "http://mock-mcp/mcp",
    serviceName: "testservice",
    resolveHeaders: async () => ({}),
    toolFilter,
  }
}

function makeFakeTools(...names) {
  return names.map((name) => ({ name, invoke: vi.fn(), schema: { type: "object" } }))
}

async function resolveTools(toolFilter) {
  const mcpConfig = makeMcpConfig(toolFilter)
  // Set up cds.context and invoke wrapModelCall
  cds.context = { __mcpDynamicTools: {} }
  mockGetTools.mockResolvedValueOnce(makeFakeTools("query", "describe", "insert"))

  let capturedTools
  const middleware = remoteMcpMiddleware()
  await middleware.wrapModelCall(
    { tools: [mcpConfig] }, // MCP placeholder — resolved and filtered by the middleware
    (req) => {
      capturedTools = req.tools
      return {}
    },
  )
  return capturedTools
}

// ─────────────────────────────────────────────────────────────────────────────

describe("remoteMcpMiddleware — mcp.tools filter", () => {
  beforeEach(() => {
    mockGetTools.mockReset()
    cds.context = {}
  })

  it("returns all tools when no toolFilter is set", async () => {
    const tools = await resolveTools(undefined)
    const names = tools.map((t) => t.name)
    expect(names).toContain("testservice_query")
    expect(names).toContain("testservice_describe")
    expect(names).toContain("testservice_insert")
  })

  it("returns all tools when toolFilter is an empty array", async () => {
    const tools = await resolveTools([])
    expect(tools.length).toBe(3)
  })

  it("filters to only the specified tools (exact match)", async () => {
    const tools = await resolveTools(["query", "describe"])
    const names = tools.map((t) => t.name)
    expect(names).toEqual(["testservice_query", "testservice_describe"])
    expect(names).not.toContain("testservice_insert")
  })

  it("returns empty array when none of the specified tools exist", async () => {
    const tools = await resolveTools(["nonexistent"])
    expect(tools).toHaveLength(0)
  })

  it("filter matches raw MCP tool names, not the prefixed names", async () => {
    // "query" is the raw name; "testservice_query" is the prefixed name exposed to the agent.
    // The filter must be specified using raw names (as declared in the MCP server).
    const withRawName = await resolveTools(["query"])
    expect(withRawName.map((t) => t.name)).toContain("testservice_query")

    const withPrefixedName = await resolveTools(["testservice_query"])
    expect(withPrefixedName).toHaveLength(0)
  })
})
