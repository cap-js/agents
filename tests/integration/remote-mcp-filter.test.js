/**
 * Unit-style tests for the mcp.tools filter in dynamicToolsMiddleware.
 *
 * Mocks MCPAdapter so no real MCP server is needed.
 */
import cds from "@sap/cds"
import { vi, describe, it, expect, beforeEach } from "vitest"
import { toolName, mcpToolKind } from "../../lib/utils/utils.js"

// ── Mock MCPAdapter before importing the middleware ───────────────────────────

const mockListTools = vi.fn()
vi.mock("@langchain/mcp-adapters", () => ({
  MCPAdapter: vi.fn().mockImplementation(function () {
    this.listTools = mockListTools
  }),
}))

const { MCPAdapter } = await import("@langchain/mcp-adapters")
const { dynamicToolsMiddleware } = await import("../../lib/agents/middleware/dynamic-tools.js")

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeTools(...names) {
  return names.map((name) => ({ name, invoke: vi.fn(), schema: { type: "object" } }))
}

function makeMcpPlaceholder(toolFilter) {
  const mcpUrl = "http://mock-mcp/mcp"
  const serviceName = "testservice"
  return {
    serviceName,
    _dynamicTools: async () => {
      const client = new MCPAdapter({
        servers: { default: { transport: "http", url: mcpUrl, headers: {} } },
        prefixToolNameWithServerName: false,
      })
      let raw = await client.listTools()
      if (toolFilter?.length) raw = raw.filter((t) => toolFilter.includes(t.name))
      for (const t of raw) {
        t.metadata = { ...t.metadata, serviceName, kind: mcpToolKind(t.name) }
        t.name = toolName(`${serviceName}_${t.name}`)
      }
      return raw
    },
  }
}

async function resolveTools(toolFilter) {
  const placeholder = makeMcpPlaceholder(toolFilter)
  cds.context = { _dynamicTools: {} }
  mockListTools.mockResolvedValueOnce(makeFakeTools("query", "describe", "insert"))

  let capturedTools
  const middleware = dynamicToolsMiddleware()
  await middleware.wrapModelCall(
    { tools: [placeholder] },
    (req) => {
      capturedTools = req.tools
      return {}
    },
  )
  return capturedTools
}

// ─────────────────────────────────────────────────────────────────────────────

describe("dynamicToolsMiddleware — mcp.tools filter", () => {
  beforeEach(() => {
    mockListTools.mockReset()
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
    const withRawName = await resolveTools(["query"])
    expect(withRawName.map((t) => t.name)).toContain("testservice_query")

    const withPrefixedName = await resolveTools(["testservice_query"])
    expect(withPrefixedName).toHaveLength(0)
  })
})
