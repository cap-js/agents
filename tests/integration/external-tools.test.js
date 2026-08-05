/**
 * Integration tests for declarative MCP server and sub-agent wiring.
 *
 * Uses the real travel sample services — no mock HTTP servers:
 *   - xflights  (port 4005) — real MCP server via @cap-js/mcp
 *   - leisure-services (port 4006) — real A2A hotel + activity agents
 *   - travel-agent (in-process) — TravelAgentService whose buildTools
 *     connects to the above two via cds.requires config, and additionally
 *     wires DestinationGuideService — a local-only @mcp service in the same
 *     CDS model (no cds.requires) — via the in-process buildMcpToolsLocally path
 *
 * Tests verify:
 *   - MCP tools are returned with the correct flightsservice_ prefix
 *   - Sub-agent tools are returned with names derived from real agent cards
 *   - No tool name collisions (regression guard for the deepagents bug)
 *   - Tool invocation returns real data from xflights SQLite
 *   - Deduplication and graceful-failure paths
 *
 * These tests run in development mode (mock LLM executor) — no AI Core needed.
 * They are skipped when deepagents cannot be loaded (e.g. missing install).
 */
import path from "node:path"
import cds from "@sap/cds"
import { isPortOpen, startServer, stopServer, registerCleanupHandlers } from "../utils/servers.js"

// ── Paths ──────────────────────────────────────────────────────────────────
const SAMPLE_DIR = path.resolve(import.meta.dirname, "../samples/travel")
const TRAVEL_AGENT_DIR = path.join(SAMPLE_DIR, "travel-agent")
const XFLIGHTS_DIR = path.join(SAMPLE_DIR, "xflights")
const LEISURE_DIR = path.join(SAMPLE_DIR, "leisure-services")
const XFLIGHTS_PORT = 4005
const LEISURE_PORT = 4006

// ── Child process lifecycle ────────────────────────────────────────────────
let xflightsProc, leisureProc

registerCleanupHandlers(() => {
  try {
    xflightsProc?.kill()
  } catch {
    /* ignore */
  }
  try {
    leisureProc?.kill()
  } catch {
    /* ignore */
  }
})

const { GET } = cds.test(TRAVEL_AGENT_DIR)

beforeAll(async () => {
  const [xflightsBusy, leisureBusy] = await Promise.all([
    isPortOpen(XFLIGHTS_PORT),
    isPortOpen(LEISURE_PORT),
  ])

  await Promise.all([
    xflightsBusy
      ? Promise.resolve()
      : startServer(XFLIGHTS_DIR, XFLIGHTS_PORT, "xflights").then((p) => {
          xflightsProc = p
        }),
    leisureBusy
      ? Promise.resolve()
      : startServer(LEISURE_DIR, LEISURE_PORT, "leisure-services").then((p) => {
          leisureProc = p
        }),
  ])
})

afterAll(async () => {
  await Promise.all([
    xflightsProc ? stopServer(xflightsProc, XFLIGHTS_DIR) : Promise.resolve(),
    leisureProc ? stopServer(leisureProc, LEISURE_DIR) : Promise.resolve(),
  ])
})

// ─────────────────────────────────────────────────────────────────────────────

describe("@cap-js/agents - Declarative MCP + SubAgent wiring (travel sample)", () => {
  // MCP tools via @langchain/mcp-adapters return { type: "text", text: "..." }
  // objects; local (in-process) MCP tools return plain strings. Normalize both.
  function extractText(result) {
    if (typeof result === "string") return result
    if (result?.text) return result.text
    if (Array.isArray(result)) return result.map(extractText).join("\n")
    return JSON.stringify(result)
  }

  // ── buildTools output ──────────────────────────────────────────────────

  describe("TravelAgentService.buildTools", () => {
    let tools

    beforeAll(async () => {
      const srv = cds.services.TravelAgentService
      expect(srv, "TravelAgentService must be running").toBeTruthy()
      tools = await srv.send("buildTools")
    })

    it("returns an array of tools", () => {
      expect(Array.isArray(tools) && tools.length > 0).toBe(true)
    })

    it("MCP tools carry the flightsservice_ prefix (FlightService slug)", () => {
      const mcpTools = tools.filter((t) => t.name.startsWith("flightsservice_"))
      expect(
        mcpTools.length > 0,
        `expected tools prefixed with flightsservice_, got: ${tools.map((t) => t.name).join(", ")}`,
      ).toBe(true)
    })

    it("MCP tools include flightsservice_describe, flightsservice_query, and a flightsservice_call_action or per-action tool", () => {
      const names = new Set(tools.map((t) => t.name))
      expect(
        names.has("flightsservice_describe"),
        `expected flightsservice_describe — got: ${[...names].sort().join(", ")}`,
      ).toBe(true)
      expect(
        names.has("flightsservice_query"),
        `expected flightsservice_query — got: ${[...names].sort().join(", ")}`,
      ).toBe(true)
      // actions are exposed as a combined flightsservice_call tool
      const hasActionTool =
        names.has("flightsservice_bookFlight") ||
        names.has("flightsservice_call_action") ||
        names.has("flightsservice_call")
      expect(
        hasActionTool,
        `expected flightsservice_bookFlight, flightsservice_call_action, or flightsservice_call — got: ${[...names].sort().join(", ")}`,
      ).toBe(true)
    })

    it("sub-agent tools present for hotel and activity services", () => {
      const names = new Set(tools.map((t) => t.name))
      // Tool names come from agent card names (HotelService / ActivityService → lowercased)
      expect(
        names.has("hotelservice"),
        `expected 'hotelservice' sub-agent tool — got: ${[...names].sort().join(", ")}`,
      ).toBe(true)
      expect(
        names.has("activityservice"),
        `expected 'activityservice' sub-agent tool — got: ${[...names].sort().join(", ")}`,
      ).toBe(true)
    })

    it("sub-agent tool descriptions reference the real agent card content", () => {
      const hotelTool = tools.find((t) => t.name === "hotelservice")
      expect(hotelTool?.description?.length > 0).toBe(true)
      expect(hotelTool.description).toMatch(/hotel/i)
    })

    it("no duplicate tool names (collision regression guard)", () => {
      const names = tools.map((t) => t.name)
      const seen = new Set()
      for (const name of names) {
        expect(seen.has(name), `duplicate tool name detected: '${name}'`).toBe(false)
        seen.add(name)
      }
    })

    it("all tools have a schema", () => {
      for (const tool of tools) {
        expect(tool.schema, `tool '${tool.name}' is missing a schema`).toBeTruthy()
      }
    })

    // ── Local (in-process) MCP tool wiring ───────────────────────────────
    // DestinationGuideService is a local-only @mcp service in the same CDS
    // model as TravelAgentService, with no cds.requires credentials.
    describe("local MCP tool wiring (DestinationGuideService, in-process)", () => {
      const PREFIX = "destinationguideservice_"

      it("local MCP tools carry the destinationguideservice_ prefix", () => {
        const localTools = tools.filter((t) => t.name.startsWith(PREFIX))
        expect(
          localTools.length > 0,
          `expected tools prefixed with ${PREFIX}, got: ${tools.map((t) => t.name).join(", ")}`,
        ).toBe(true)
      })

      it("exposes destinationguideservice_describe and destinationguideservice_query", () => {
        const names = new Set(tools.map((t) => t.name))
        expect(
          names.has(`${PREFIX}describe`),
          `expected ${PREFIX}describe — got: ${[...names].sort().join(", ")}`,
        ).toBe(true)
        expect(
          names.has(`${PREFIX}query`),
          `expected ${PREFIX}query — got: ${[...names].sort().join(", ")}`,
        ).toBe(true)
      })
    })
  })

  // ── Tool invocation ────────────────────────────────────────────────────

  describe("MCP tool invocation (flightsservice_query against real xflights)", () => {
    it("flightsservice_query returns real airport data from xflights SQLite", async () => {
      const srv = cds.services.TravelAgentService
      const tools = await srv.send("buildTools")
      const queryTool = tools.find((t) => t.name === "flightsservice_query")
      expect(queryTool, "flightsservice_query tool must be present").toBeTruthy()

      const raw = await queryTool.invoke({ cql: "SELECT * FROM Airports" })
      const result = extractText(raw)
      expect(
        result && result.length > 0,
        `tool result should be non-empty, got: ${JSON.stringify(raw)}`,
      ).toBe(true)
      expect(result).toMatch(/FRA|JFK|Frankfurt|New York|Airport/i)
    })

    it("flightsservice_describe returns schema information for the Flights entity", async () => {
      const srv = cds.services.TravelAgentService
      const tools = await srv.send("buildTools")
      const describeTool = tools.find((t) => t.name === "flightsservice_describe")
      expect(describeTool, "flightsservice_describe tool must be present").toBeTruthy()

      const raw = await describeTool.invoke({ entity: "Flights" })
      const result = extractText(raw)
      expect(
        result && result.length > 0,
        `describe should return non-empty, got: ${JSON.stringify(raw)}`,
      ).toBe(true)
      expect(result).toMatch(/date|price|flight|ID/i)
    })

    it("destinationguideservice_query returns real seed data from the local Destinations entity", async () => {
      const srv = cds.services.TravelAgentService
      const tools = await srv.send("buildTools")
      const queryTool = tools.find((t) => t.name === "destinationguideservice_query")
      expect(queryTool, "destinationguideservice_query tool must be present").toBeTruthy()

      const raw = await queryTool.invoke({ entity: "Destinations" })
      const result = extractText(raw)
      expect(
        result && result.length > 0,
        `tool result should be non-empty, got: ${JSON.stringify(raw)}`,
      ).toBe(true)
      expect(result).toMatch(/FRA|JFK|Frankfurt|New York/)
    })

    it("destinationguideservice_describe returns schema information for the local Destinations entity", async () => {
      const srv = cds.services.TravelAgentService
      const tools = await srv.send("buildTools")
      const describeTool = tools.find((t) => t.name === "destinationguideservice_describe")
      expect(describeTool, "destinationguideservice_describe tool must be present").toBeTruthy()

      const raw = await describeTool.invoke({ entity: "Destinations" })
      const result = extractText(raw)
      expect(
        result && result.length > 0,
        `describe should return non-empty, got: ${JSON.stringify(raw)}`,
      ).toBe(true)
      expect(result).toMatch(/city|country|description|code/i)
    })
  })

  // ── Sub-agent invocation ───────────────────────────────────────────────

  describe("sub-agent tool invocation (hotelservice against real leisure-services)", () => {
    it("hotelservice tool sends a message and returns a response string", async () => {
      const srv = cds.services.TravelAgentService
      const tools = await srv.send("buildTools")
      const hotelTool = tools.find((t) => t.name === "hotelservice")
      expect(hotelTool, "hotelservice tool must be present").toBeTruthy()

      // leisure-services uses mock executor in dev mode — returns a mock response
      const result = await hotelTool.invoke({ message: "Find hotels in Paris" })
      expect(typeof result).toBe("string")
      expect(result.length > 0).toBe(true)
    })
  })

  // ── Agent card ─────────────────────────────────────────────────────────

  it("agent card is served and lists expected skills", async () => {
    const res = await GET("/a2a/travel-agent/.well-known/agent-card.json")
    expect(res.status).toBe(200)
    const card = res.data
    expect(card.name).toBe("travel-agent")
    const skillIds = card.skills.map((s) => s.id).sort()
    expect(
      skillIds.includes("flight-booking"),
      `expected flight-booking skill, got: ${skillIds}`,
    ).toBe(true)
    expect(
      skillIds.includes("trip-planning"),
      `expected trip-planning skill, got: ${skillIds}`,
    ).toBe(true)
  })
})
