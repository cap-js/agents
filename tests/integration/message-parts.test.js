import cds from "@sap/cds"
import { setup, teardown, resetCapture, captured } from "../utils/telemetry-utils.js"

// Patch console.info before cds.test() so CDS log is captured
setup()

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
axios.defaults.validateStatus = () => true

after(teardown)
beforeEach(resetCapture)

function sendParts(service, parts) {
  return POST(`/a2a/${service}/`, {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        parts,
      },
    },
  })
}

/**
 * Extract the "text" field logged by lib/index.js `LOG.info("request", { text })`.
 * CDS serialises the log object as JSON on console.info.
 */
function capturedRequestText() {
  for (const line of captured) {
    try {
      const obj = JSON.parse(line.slice(line.indexOf("{")))
      if (obj.text !== undefined) return obj.text
    } catch {
      // plain-text log lines — skip
    }
  }
  return undefined
}

describe("@cap-js/agents - message part extraction (partsToText via HTTP)", () => {
  it("text part — extracted text reaches request log", async () => {
    await sendParts("graph-book", [{ kind: "text", text: "Show me books" }])
    expect(capturedRequestText()).toBe("Show me books")
  })

  it("data part — JSON-stringified data reaches request log", async () => {
    await sendParts("graph-book", [{ kind: "data", data: { query: "books", limit: 3 } }])
    const text = capturedRequestText()
    expect(text).toContain('"query"')
    expect(text).toContain('"books"')
  })

  it("mixed text + data parts — both joined in request log", async () => {
    await sendParts("graph-book", [
      { kind: "text", text: "Filter by:" },
      { kind: "data", data: { genre: "fiction" } },
    ])
    const text = capturedRequestText()
    expect(text).toContain("Filter by:")
    expect(text).toContain('"genre"')
    expect(text).toContain('"fiction"')
  })

  it("file part only — empty text (file skipped), agent still completes", async () => {
    const res = await sendParts("graph-book", [
      { kind: "file", file: { bytes: "aGVsbG8=", mimeType: "image/png", name: "img.png" } },
    ])
    // file-only message: partsToText returns "" so no request log text line is emitted
    // (lib/index.js only logs text for message/send, and text will be empty string —
    // the agent completes because the graph doesn't require non-empty input)
    expect(res.data.result?.status?.state).toBe("completed")
  })

  it("text + file part — only text part extracted in log", async () => {
    await sendParts("graph-book", [
      { kind: "text", text: "Describe this image" },
      { kind: "file", file: { bytes: "aGVsbG8=", mimeType: "image/png", name: "img.png" } },
    ])
    const text = capturedRequestText()
    expect(text).toContain("Describe this image")
    // file bytes must NOT appear in the text extraction
    expect(text).not.toContain("aGVsbG8=")
  })
})
