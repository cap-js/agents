/**
 * Integration tests for LOCAL (in-process) subagent wiring.
 *
 * Unlike external-tools.test.js — which connects TravelAgentService to remote
 * A2A agents over HTTP via cds.requires — this exercises buildSubAgentTool: the
 * path taken when a peer @agent service lives in the SAME CDS model and has no
 * cds.requires credentials. buildTools then discovers it via availableAgents
 * auto-discovery and drives its LangGraphExecutor directly (no HTTP round-trip).
 *
 * leisure-services declares two local @agent services (HotelService,
 * ActivityService). From HotelService's perspective, ActivityService is a
 * credential-less peer → the local subagent tool is built and invoked here.
 *
 * Runs in development mode (mock LLM executor) — no AI Core needed.
 */
import path from "node:path"
import cds from "@sap/cds"

const LEISURE_DIR = path.resolve(import.meta.dirname, "../projects/travel/leisure-services")

cds.test(LEISURE_DIR)

describe("@cap-js/agents - local (in-process) subagent wiring", () => {
  it("HotelService.buildTools exposes ActivityService as a local subagent tool", async () => {
    const srv = cds.services.HotelService
    expect(srv, "HotelService must be running").toBeTruthy()

    const tools = await srv.send("buildTools")
    const names = new Set(tools.map((t) => t.name))
    expect(
      names.has("activityservice"),
      `expected 'activityservice' local subagent tool — got: ${[...names].sort().join(", ")}`,
    ).toBe(true)
  })

  it("the local subagent tool description reflects the peer agent card", async () => {
    const srv = cds.services.HotelService
    const tools = await srv.send("buildTools")
    const activityTool = tools.find((t) => t.name === "activityservice")
    expect(activityTool?.description?.length > 0).toBe(true)
    expect(activityTool.description).toMatch(/activit/i)
  })

  it("invoking the local subagent tool drives the peer graph and returns a string", async () => {
    const srv = cds.services.HotelService
    const tools = await srv.send("buildTools")
    const activityTool = tools.find((t) => t.name === "activityservice")
    expect(activityTool, "activityservice tool must be present").toBeTruthy()

    // Mock LLM executor in dev mode returns a deterministic response — we only
    // assert the local invocation completes and yields a non-empty string.
    const result = await activityTool.invoke({ message: "Find activities in Paris" })
    expect(typeof result).toBe("string")
    expect(result.length > 0).toBe(true)
  })
})
