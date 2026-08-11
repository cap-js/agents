/* eslint-disable no-await-in-loop */
import { spawn } from "node:child_process"
import { readdirSync, unlinkSync, readFileSync } from "node:fs"
import { createConnection } from "node:net"
import path from "node:path"
import cds from "@sap/cds"
import createHelpers from "../utils/helpers.js"
import { isPortOpen, startServer, stopServer, registerCleanupHandlers } from "../utils/servers.js"

const SAMPLE_DIR = path.resolve(import.meta.dirname, "../projects/travel")
const TRAVEL_AGENT_DIR = path.join(SAMPLE_DIR, "travel-agent")
const XFLIGHTS_DIR = path.join(SAMPLE_DIR, "xflights")
const LEISURE_DIR = path.join(SAMPLE_DIR, "leisure-services")
const XFLIGHTS_PORT = 4005
const LEISURE_PORT = 4006

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

const { POST, axios, GET } = cds.test(TRAVEL_AGENT_DIR)

async function collectToolCallsFromCheckpoints(threadId) {
  const { BaseCheckpointSaver } = await import("@langchain/langgraph-checkpoint")
  // Use BaseCheckpointSaver's serde to deserialize checkpoint data
  const saver = new (class extends BaseCheckpointSaver {})()
  const serde = saver.serde

  const rows = await SELECT.from("cap.agent.Checkpoints").where({ thread_id: threadId })
  const tools = new Set()

  for (const row of rows) {
    let checkpoint
    try {
      checkpoint = await serde.loadsTyped("json", row.checkpoint)
    } catch {
      continue
    }
    const messages = checkpoint?.channel_values?.messages || []
    for (const msg of messages) {
      const calls = msg?.tool_calls || msg?.kwargs?.tool_calls
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const name = tc?.name || tc?.function?.name
          if (name) tools.add(name)
        }
      }
    }
  }

  return tools
}

describe("@cap-js/agents - Travel Sample E2E", () => {
  let helpers

  beforeAll(async () => {
    helpers = createHelpers({ POST, axios })
  })

  // ─── Smoke test: agent card built from skills/ scan ──────────────
  it("agent card is built from AGENTS.md + skills/ directory", async () => {
    const res = await GET("/a2a/travel-agent/.well-known/agent-card.json")

    expect(
      res.status,
      `agent-card request failed: ${res.status}\n` +
        `body: ${typeof res.data === "string" ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500)}`,
    ).toBe(200)
    const card = res.data

    expect(card.name, "card.name should come from AGENTS.md").toBe("travel-agent")
    expect(card.description).toMatch(/coordinates hotel bookings/i)
    expect(card.version).toBe("1.0.0")

    const skillIds = card.skills.map((s) => s.id).sort()
    expect(
      skillIds,
      `expected four skills from skills/ scan, got: ${JSON.stringify(skillIds)}`,
    ).toEqual(["file-based-planning", "flight-booking", "itinerary-summary", "trip-planning"])

    const trip = card.skills.find((s) => s.id === "trip-planning")
    expect(trip.name).toMatch(/Trip Planning/i)
    expect(trip.tags.includes("travel"), `expected 'travel' in tags: ${trip.tags}`).toBeTruthy()
    expect(
      trip.examples.some((e) => /paris/i.test(e)),
      `expected a paris example, got: ${JSON.stringify(trip.examples)}`,
    ).toBeTruthy()

    expect(
      card.skills.find((s) => s.id === "plan"),
      "card should not contain the agentify-mode 'plan' skill",
    ).toBe(undefined)
  })

  // ─── E2E: Plan a Paris trip ──────────────────────────────────────
  it("plans a Paris trip using both xflights MCP and leisure-services A2A", async () => {
    const { sendMessage } = helpers
    const res = await sendMessage(
      "travel-agent",
      "Plan a weekend trip to Paris with Hotels, Flights and activities. Make sure to use the provided tools to search for Hotels, Flights, and Activities",
    )

    expect(
      res.data.result?.status?.state,
      `Task did not complete:\n${JSON.stringify(res.data, null, 2).slice(0, 2000)}`,
    ).toBe("completed")

    const text = res.data.result.status.message.parts[0].text
    expect(text && text.length > 0, "response text should be non-empty").toBeTruthy()
    expect(text, "response should mention Paris").toMatch(/paris/i)
    expect(text, "response should reference hotels (leisure-services)").toMatch(/hotel/i)
    expect(text, "response should reference activities (leisure-services)").toMatch(
      /activit|tour|cruise|class|experience|museum/i,
    )
    expect(text, "response should reference flights (xflights MCP)").toMatch(
      /flight|airport|airline|CDG|ORY/i,
    )

    const contextId = res.data.result.contextId
    expect(contextId, "task result must include contextId").toBeTruthy()

    const threadId = `TravelAgentService:${contextId}`
    const toolNames = await collectToolCallsFromCheckpoints(threadId)

    expect(
      toolNames.size > 0,
      `expected at least one tool call recorded in checkpoints for ${threadId}, got none`,
    ).toBeTruthy()

    expect(
      toolNames.has("hotelservice"),
      `expected 'hotelservice' tool call (leisure-services A2A). Recorded tools: ${[...toolNames].sort().join(", ")}`,
    ).toBeTruthy()
    expect(
      toolNames.has("activityservice"),
      `expected 'activityservice' tool call (leisure-services A2A). Recorded tools: ${[...toolNames].sort().join(", ")}`,
    ).toBeTruthy()

    const mcpToolUsed = [
      "flightsservice_describe",
      "flightsservice_query",
      "flightsservice_bookFlight",
      "flightsservice_cancelFlight",
      "flightsservice_call",
    ].some((n) => toolNames.has(n))
    expect(
      mcpToolUsed,
      `expected at least one xflights MCP tool call (flightsservice_describe/query/bookFlight/cancelFlight). Recorded tools: ${[...toolNames].sort().join(", ")}`,
    ).toBeTruthy()
  })
})

// ─── File I/O E2E (deep-agent path): upload CSV → read_file → write_file → FilePart ───
describe("@cap-js/agent - File I/O (travel-agent — deep-agent path)", () => {
  let csvBase64
  let savedTaskId
  let savedFileBytesB64

  before(() => {
    csvBase64 = readFileSync(path.join(TRAVEL_AGENT_DIR, "trip-requests.csv")).toString("base64")
  })

  it("agent card reflects per-app fileIO MIME overrides (CSV in / markdown out)", async () => {
    const res = await GET("/a2a/travel-agent/.well-known/agent-card.json")
    expect(res.status, `agent-card request failed: ${res.status}`).toBe(200)
    const card = res.data
    expect(
      Array.isArray(card.defaultInputModes) && card.defaultInputModes.includes("text/csv"),
      `expected text/csv in defaultInputModes; got: ${JSON.stringify(card.defaultInputModes)}`,
    ).toBeTruthy()
    expect(
      Array.isArray(card.defaultOutputModes) &&
        card.defaultOutputModes.includes("text/plain") &&
        card.defaultOutputModes.includes("text/markdown"),
      `expected text/csv in defaultOutputModes; got: ${JSON.stringify(card.defaultOutputModes)}`,
    ).toBeTruthy()
  })

  it("ingests CSV → read_file → write_file('/outputs/alice-plan.md') → emits FilePart artifact", async () => {
    const res = await POST(`/a2a/travel-agent/`, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [
            {
              kind: "text",
              text: "Here is the data for three people. Read the file, then plan the first person's trip — search for flights from Frankfurt to New York, a hotel in New York, and food or culture activities. Save the plan to /outputs/alice-plan.md",
            },
            {
              kind: "file",
              file: { name: "trip-requests.csv", mimeType: "text/csv", bytes: csvBase64 },
            },
          ],
        },
      },
    })

    const result = res.data.result
    expect(
      result?.status?.state,
      `Task did not complete:\n${JSON.stringify(res.data, null, 2).slice(0, 2000)}`,
    ).toBe("completed")

    savedTaskId = result.id
    const contextId = result.contextId

    // Persisted upload
    const InputFiles = cds.model.definitions["cap.agent.Tasks.inputFiles"]
    const inputs = await cds.run(
      SELECT.from(InputFiles).where({
        "up_.contextId": contextId,
        filename: "trip-requests.csv",
      }),
    )
    expect(inputs.length, "expected the uploaded CSV to be persisted").toBe(1)
    expect(inputs[0].mimeType).toBe("text/csv")

    // FilePart artifact emitted from /outputs/
    const filePart = (result.artifacts || [])
      .flatMap((a) => a.parts || [])
      .find((p) => p.kind === "file" && /alice/i.test(p.file?.name || ""))
    expect(filePart, "expected an itinerary FilePart artifact for Alice").toBeTruthy()
    savedFileBytesB64 = filePart.file.bytes
    const decoded = Buffer.from(filePart.file.bytes, "base64").toString("utf-8")
    // Loose content checks — LLM phrasing varies.
    expect(decoded.toLowerCase(), "itinerary should mention the traveller").toMatch(/alice/)
    expect(decoded.toLowerCase(), "itinerary should reference at least one booked domain").toMatch(
      /flight|hotel|activit/,
    )

    // Output file persisted in CDS
    const OutputFiles = cds.model.definitions["cap.agent.Tasks.outputFiles"]
    const outputs = await cds.run(SELECT.from(OutputFiles).where({ up__taskId: savedTaskId }))
    expect(outputs.length >= 1, "expected at least one output file row").toBeTruthy()

    // Tool-call witness: deepagents' built-in read_file + write_file fired.
    const threadId = `TravelAgentService:${contextId}`
    const toolNames = await collectToolCallsFromCheckpoints(threadId)
    expect(
      toolNames.has("read_file"),
      `expected read_file tool call. Recorded tools: ${[...toolNames].sort().join(", ")}`,
    ).toBeTruthy()
    expect(
      toolNames.has("write_file"),
      `expected write_file tool call. Recorded tools: ${[...toolNames].sort().join(", ")}`,
    ).toBeTruthy()
  })

  it("tasks/get returns the same FilePart artifact (round-trip persistence check)", async () => {
    expect(
      savedTaskId,
      "Previous test must have populated savedTaskId — was it skipped or did it fail?",
    ).toBeTruthy()
    const res = await POST(`/a2a/travel-agent/`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/get",
      params: { id: savedTaskId },
    })
    const result = res.data.result
    expect(
      result,
      `tasks/get returned no result: ${JSON.stringify(res.data).slice(0, 500)}`,
    ).toBeTruthy()
    expect(result.id).toBe(savedTaskId)
    expect(result.status?.state).toBe("completed")
    const filePart = (result.artifacts || [])
      .flatMap((a) => a.parts || [])
      .find((p) => p.kind === "file" && /alice/i.test(p.file?.name || ""))
    expect(filePart, "expected the FilePart to round-trip through tasks/get").toBeTruthy()
    expect(
      filePart.file.bytes.length,
      "round-tripped FilePart byte count should match the originally emitted artifact",
    ).toBe(savedFileBytesB64.length)
  })

  it("graceful response when reading uploaded file from a fresh conversation (no-file probe)", async () => {
    // No file part, no contextId → server generates a fresh contextId →
    // no /uploads/ entry exists → UploadsBackend.read returns "not found".
    const res = await POST(`/a2a/travel-agent/`, {
      jsonrpc: "2.0",
      id: 3,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [
            {
              kind: "text",
              text: "Please read_file('/uploads/trip-requests.csv') and tell me what's in it.",
            },
          ],
        },
      },
    })
    const result = res.data.result
    expect(
      ["completed", "input-required"].includes(result.status.state),
      `expected graceful state, got: ${result.status.state}`,
    ).toBeTruthy()
    const text = (result.status.message?.parts || []).map((p) => p.text || "").join(" ")
    expect(
      text.toLowerCase(),
      "agent should acknowledge missing file or ask user to upload",
    ).toMatch(/not found|no .* file|empty|doesn't|does not|don't|do not|upload|provide/)
  })
})
