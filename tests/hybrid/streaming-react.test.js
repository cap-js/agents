/**
 * Token streaming tests for the standard ReAct agent path (bookshop CatalogService).
 * Run with: npm run test:hybrid
 *
 * Tests that _streamWithPublish emits incremental artifact-update frames
 * and that cds.env.agents.streaming=false falls back to the blocking invoke() path.
 */
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../samples/bookshop")
import createHelpers from "../utils/helpers.js"
const { streamMessage, parseSSEFrames, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agents - Token streaming, ReAct agent (hybrid)", () => {
  setupErrorDetection()

  let origStreaming

  beforeEach(() => {
    origStreaming = cds.env.agents?.streaming
  })

  afterEach(() => {
    if (cds.env.agents) cds.env.agents.streaming = origStreaming
  })

  it("emits multiple incremental artifact-update frames (streaming:true)", async () => {
    const res = await streamMessage("catalog", "Show me all books")
    const frames = parseSSEFrames(res.data)

    const artifactFrames = frames.filter((f) => f.result?.kind === "artifact-update")

    // Real token streaming (not a single merged chunk): the final answer must arrive
    // as more than one incremental frame plus the authoritative final emit.
    expect(
      artifactFrames.length,
      "expected more than one artifact-update frame (real token streaming)",
    ).toBeGreaterThan(1)

    // append / lastChunk are A2A event-level fields (siblings of `artifact`).
    // First frame: append:false (new artifact, not yet appended)
    const firstArtifact = artifactFrames[0]
    expect(firstArtifact.result.artifact.artifactId).toBe("response")
    expect(firstArtifact.result.artifact.parts[0].kind).toBe("text")
    expect(firstArtifact.result.artifact.parts[0].text.length).toBeGreaterThan(0)
    expect(firstArtifact.result.append ?? false).toBe(false)

    // At least one intermediate incremental frame must be an append (append:true, lastChunk:false)
    const incrementalFrames = artifactFrames.filter(
      (f) => f.result?.append === true && f.result?.lastChunk !== true,
    )
    expect(
      incrementalFrames.length,
      "expected at least one incremental append frame",
    ).toBeGreaterThan(0)

    // Last frame: lastChunk:true, authoritative replace (append:false)
    const lastArtifact = artifactFrames[artifactFrames.length - 1]
    expect(lastArtifact.result.lastChunk).toBe(true)
    expect(lastArtifact.result.append).toBe(false)

    // Task must complete successfully
    const completed = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.final === true,
    )
    expect(completed?.result?.status?.state).toBe("completed")
  }, 180000)

  it("falls back to single artifact frame when streaming:false", async () => {
    cds.env.agents ??= {}
    cds.env.agents.streaming = false

    const res = await streamMessage("catalog", "Show me all books")
    const frames = parseSSEFrames(res.data)

    const artifactFrames = frames.filter((f) => f.result?.kind === "artifact-update")

    // No incremental (append:true, lastChunk:false) frames — blocking path only
    const incrementalFrames = artifactFrames.filter(
      (f) => f.result?.append === true && f.result?.lastChunk !== true,
    )
    expect(
      incrementalFrames.length,
      "expected no incremental token frames when streaming:false",
    ).toBe(0)

    // Task must still complete with a response
    const completed = frames.find(
      (f) => f.result?.kind === "status-update" && f.result?.final === true,
    )
    expect(completed?.result?.status?.state).toBe("completed")
    expect(completed?.result?.status?.message?.parts?.[0]?.text?.length).toBeGreaterThan(0)
  }, 180000)
})
