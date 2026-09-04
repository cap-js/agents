/**
 * Token streaming tests for the deep agent path (deep-agent sample, product-agent).
 * Requires hybrid executor (real LLM via AI Core + deepagents createDeepAgent).
 * Run with: npm run test:hybrid
 *
 * Tests that _streamWithPublish emits incremental artifact-update frames
 * and that cds.env.agents.streaming=false falls back to the blocking invoke() path.
 */
import cds from "@sap/cds"
const { POST, axios } = cds.test(import.meta.dirname + "/../projects/deep-agent")
import createHelpers from "../utils/helpers.js"
const { streamMessage, parseSSEFrames, setupErrorDetection } = createHelpers({ POST, axios })

describe("@cap-js/agents - Token streaming, deep agent (hybrid)", () => {
  setupErrorDetection()

  let origStreaming

  beforeEach(() => {
    origStreaming = cds.env.agents?.streaming
  })

  afterEach(() => {
    if (cds.env.agents) cds.env.agents.streaming = origStreaming
  })

  it("emits multiple incremental artifact-update frames (streaming:true)", async () => {
    const res = await streamMessage("product-agent", "List all products")
    const frames = parseSSEFrames(res.data)

    const artifactFrames = frames.filter((f) => f.result?.kind === "artifact-update")

    // Real token streaming: more than one frame (incremental tokens + final emit).
    expect(
      artifactFrames.length,
      "expected more than one artifact-update frame (real token streaming)",
    ).toBeGreaterThan(1)

    // append / lastChunk are A2A event-level fields (siblings of `artifact`).
    // First frame: append:false (new artifact)
    const firstArtifact = artifactFrames[0]
    expect(firstArtifact.result.artifact.artifactId).toBe("thinking-0")
    expect(firstArtifact.result.artifact.parts[0].kind).toBe("text")
    expect(firstArtifact.result.artifact.parts[0].text.length).toBeGreaterThan(0)
    expect(firstArtifact.result.append ?? false).toBe(false)

    // At least one intermediate incremental append frame (append:true, lastChunk:false)
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
  }, 120000)

  it("falls back to single artifact frame when streaming:false", async () => {
    cds.env.agents ??= {}
    cds.env.agents.streaming = false

    const res = await streamMessage("product-agent", "List all products")
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
  }, 120000)
})
