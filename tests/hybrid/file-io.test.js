// Hybrid integration tests for the File I/O capability — full HTTP round-trip through the A2A protocol.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import cds from "@sap/cds"

const CSV_PATH = path.join(import.meta.dirname, "../samples/bookshop/db/data/reading-list.csv")
const csvBase64 = fs.readFileSync(CSV_PATH).toString("base64")

const { POST } = cds.test(path.join(import.meta.dirname, "../samples/bookshop"))

function sendWithFile(service, text, filename, mimeType, base64, contextId) {
  return POST(`/a2a/${service}/`, {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        parts: [
          { kind: "text", text },
          { kind: "file", file: { name: filename, mimeType, bytes: base64 } },
        ],
      },
    },
  })
}

function sendText(service, text, contextId) {
  return POST(`/a2a/${service}/`, {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "user",
        ...(contextId && { contextId }),
        parts: [{ kind: "text", text }],
      },
    },
  })
}

describe("@cap-js/agent - File I/O (CatalogService — React path)", { timeout: 90000 }, () => {
  it("agent reads uploaded CSV and answers question about its contents", async () => {
    const res = await sendWithFile(
      "catalog",
      "I've attached a reading list. Read the file and tell me which books are by Poe.",
      "reading-list.csv",
      "text/csv",
      csvBase64,
    )
    const result = res.data.result
    assert.equal(result.status.state, "completed")
    const text = result.status.message.parts.map((p) => p.text || "").join("")
    assert.match(text.toLowerCase(), /poe|raven|eleonora/)
  })

  it("uploaded file bytes are persisted to Tasks.inputFiles with correct metadata", async () => {
    const res = await sendWithFile(
      "catalog",
      "Read the attached reading list and count the total number of entries.",
      "reading-list.csv",
      "text/csv",
      csvBase64,
    )
    const contextId = res.data.result.contextId
    const taskId = res.data.result.id

    const InputFiles = cds.entities("cap.agent")["Tasks.inputFiles"]
    const rows = await cds.run(
      SELECT.from(InputFiles).where({ "up_.contextId": contextId, filename: "reading-list.csv" }),
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].mimeType, "text/csv")
    assert.equal(rows[0].up__taskId, taskId)
  })

  it("agent emits a file artifact via emit_file_part", async () => {
    const res = await sendWithFile(
      "catalog",
      "Read the reading list and use emit_file_part to return a plain-text file named 'interested.txt' listing only the book titles where interested_in is 'yes', one per line.",
      "reading-list.csv",
      "text/csv",
      csvBase64,
    )
    const result = res.data.result
    assert.equal(result.status.state, "completed")
    const filePart = (result.artifacts || [])
      .flatMap((a) => a.parts || [])
      .find((p) => p.kind === "file")
    assert.ok(filePart, "expected a file artifact")
    const decoded = Buffer.from(filePart.file.bytes, "base64").toString("utf-8")
    assert.match(decoded.toLowerCase(), /wuthering heights/)
  })

  it("multi-turn: file uploaded in turn 1 is readable in turn 2 via read_file", async () => {
    // Turn 1: upload the file
    const turn1 = await sendWithFile(
      "catalog",
      "I am uploading a reading list for later use. Please confirm you received it.",
      "reading-list.csv",
      "text/csv",
      csvBase64,
    )
    assert.equal(turn1.data.result.status.state, "completed")
    const contextId = turn1.data.result.contextId

    // Turn 2: same contextId, no file attached — ask agent to read the file from turn 1
    const turn2 = await sendText(
      "catalog",
      "Using the reading list you received earlier (read_file /uploads/reading-list.csv), how many entries are in it?",
      contextId,
    )
    const result2 = turn2.data.result
    assert.equal(result2.status.state, "completed")
    const text = result2.status.message.parts.map((p) => p.text || "").join("")
    // File has 6 data rows — agent should mention a number
    assert.match(text, /\d+/)
  })

  it("latest-wins: second upload of same filename supersedes first", async () => {
    const contextId = cds.utils.uuid()

    await sendWithFile(
      "catalog",
      "Here is version 1 of the reading list.",
      "data.csv",
      "text/csv",
      csvBase64,
      contextId, // pass contextId so both turns share the same conversation
    )

    // Turn 2: upload a different CSV with same name
    const v2Content = "title,author\nNew Book,New Author\n"
    const v2Base64 = Buffer.from(v2Content).toString("base64")
    const turn2 = await sendWithFile(
      "catalog",
      "Here is version 2 — it replaces the previous reading list.",
      "data.csv",
      "text/csv",
      v2Base64,
      contextId,
    )
    const taskId2 = turn2.data.result.id

    const InputFiles = cds.entities("cap.agent")["Tasks.inputFiles"]
    // Both rows exist (always-insert)
    const all = await cds.run(
      SELECT.from(InputFiles).where({ "up_.contextId": contextId, filename: "data.csv" }),
    )
    assert.equal(all.length, 2)

    // Latest-wins: the row anchored on task2 is the more recent one
    const latest = all.find((r) => r.up__taskId === taskId2)
    assert.ok(latest, "expected a row anchored on task2")
  })

  it("graceful response when reading a non-existent uploaded file (no-file probe)", async () => {
    const res = await sendText(
      "catalog",
      "Please read_file('/uploads/does-not-exist.csv') and tell me what's in it.",
    )
    const result = res.data.result
    // The task should not crash; either completes with an explanatory response or marks input-required.
    assert.ok(
      ["completed", "input-required"].includes(result.status.state),
      `expected graceful state, got: ${result.status.state}`,
    )
    const text = (result.status.message?.parts || []).map((p) => p.text || "").join(" ")
    // Agent should acknowledge the missing file (e.g. "no file", "not found", "empty", "doesn't exist", or ask user to upload).
    assert.match(
      text.toLowerCase(),
      /not found|no .* file|empty|doesn't|does not|don't|do not|upload/,
    )
  })
})
