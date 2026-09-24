// Integration tests for the input-file size + MIME allowlist enforcement
// added for H6 (unbounded base64 decode OOM).
//
// The guard lives in srv/handlers/graph-executor.js and uses
// Buffer.byteLength (O(1), zero-alloc) to reject oversized or disallowed
// base64 payloads before Buffer.from() materializes them.

import path from "node:path"
import { fileURLToPath } from "node:url"
import cds from "@sap/cds"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { POST, axios } = cds.test(path.join(__dirname, "../projects/bookshop"))
axios.defaults.validateStatus = () => true

const FILE_IO_KEY = "fileIO"

let originalFileIO

beforeAll(() => {
  cds.env.agents = cds.env.agents || {}
  originalFileIO = { ...(cds.env.agents[FILE_IO_KEY] || {}) }
  cds.env.agents[FILE_IO_KEY] = {
    ...originalFileIO,
    enabled: true,
    // 1 KiB cap keeps fixtures small while exercising the guard.
    maxInputFileSizeBytes: 1024,
    // Narrow allowlist so an image/png upload is rejected by the MIME check.
    defaultInputModes: ["text/plain"],
  }
})

afterAll(() => {
  cds.env.agents[FILE_IO_KEY] = originalFileIO
})

function sendFile(service, file) {
  return POST(`/a2a/${service}/`, {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        parts: [
          { kind: "text", text: "please note the attached file" },
          { kind: "file", file },
        ],
      },
    },
  })
}

async function inputFilesFor(taskId) {
  await cds.connect.to("db")
  const InputFiles = cds.model.definitions["cap.agent.Tasks.inputFiles"]
  return SELECT.from(InputFiles).where({ up__taskId: taskId })
}

describe("@cap-js/agents - inbound FilePart guard (graph-executor)", () => {
  it("oversized inbound FilePart is rejected before decode; no Tasks.inputFiles row is written", async () => {
    // Base64 payload that decodes to just over the 1 KiB cap.
    const oversized = Buffer.alloc(
      cds.env.agents.fileIO.maxInputFileSizeBytes + 128,
      0x41,
    ).toString("base64")
    const res = await sendFile("graph-book", {
      name: "attack.txt",
      mimeType: "text/plain",
      bytes: oversized,
    })
    expect(res.data.result?.status?.state).toBe("completed")

    const taskId = res.data.result?.id
    expect(taskId).toBeTruthy()
    const rows = await inputFilesFor(taskId)
    // Guard skipped the persist; no row for the rejected file.
    expect(rows.find((r) => r.filename === "attack.txt")).toBeUndefined()
  })

  it("FilePart with disallowed mimeType is rejected", async () => {
    // Fits under the size cap, but image/png is not in defaultInputModes.
    const res = await sendFile("graph-book", {
      name: "shot.png",
      mimeType: "image/png",
      // ~8 bytes of base64 → well below the 1 KiB cap
      bytes: Buffer.from("hello").toString("base64"),
    })
    expect(res.data.result?.status?.state).toBe("completed")

    const taskId = res.data.result?.id
    const rows = await inputFilesFor(taskId)
    expect(rows.find((r) => r.filename === "shot.png")).toBeUndefined()
  })

  it("FilePart within cap and allowed mimeType is persisted", async () => {
    const res = await sendFile("graph-book", {
      name: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("some notes for the agent").toString("base64"),
    })
    expect(res.data.result?.status?.state).toBe("completed")

    const taskId = res.data.result?.id
    const rows = await inputFilesFor(taskId)
    expect(rows.find((r) => r.filename === "notes.txt")).toBeDefined()
  })
})
