// Integration tests for CdsFileStore against a running CDS runtime.
// Exercise composition cascade-delete via @cap-js/attachments and the
// HANA-driver-defeating upsert pattern in saveOutputFile.

import path from "node:path"
import { fileURLToPath } from "node:url"
import cds from "@sap/cds"
import { CdsFileStore } from "../../lib/protocol/persistence/file-store.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// side-effect: registers in-memory CDS bootstrap for the integration tests
cds.test(path.join(__dirname, "../projects/bookshop"))

describe("@cap-js/agent - composition cascade delete", () => {
  it("deleting a Messages row removes its inputFiles children", async () => {
    await cds.connect.to("db")
    const { Messages } = cds.entities("cap.agent")
    const { inputFiles } = cds.entities("cap.agent.Messages")

    const taskId = cds.utils.uuid()
    const contextId = cds.utils.uuid()

    await INSERT.into(Messages).entries({
      ID: taskId,
      session: contextId,
      state: "completed",
      agentService: "test",
    })

    // Insert child inputFiles row directly (bypassing attachments for test isolation)
    await INSERT.into(inputFiles).entries({
      ID: cds.utils.uuid(),
      up__ID: taskId,
      filename: "test.csv",
      mimeType: "text/csv",
    })

    // Verify child exists
    const beforeRows = await SELECT.from(inputFiles).where({ up__ID: taskId })
    expect(beforeRows.length).toBe(1)

    // Delete parent
    await DELETE.from(Messages).where({ ID: taskId })

    // Child must be gone (cascade delete via composition)
    const after = await SELECT.from(inputFiles).where({ up__ID: taskId })
    expect(after.length).toBe(0)
  })
})

describe("@cap-js/agent - CdsFileStore.saveOutputFile upsert", () => {
  it("second saveOutputFile call for same (taskId, filename) updates the row, not inserts", async () => {
    await cds.connect.to("db")
    const { Messages } = cds.entities("cap.agent")
    const { outputFiles } = cds.entities("cap.agent.Messages")
    const store = new CdsFileStore()

    const taskId = cds.utils.uuid()
    const contextId = cds.utils.uuid()

    await INSERT.into(Messages).entries({
      ID: taskId,
      session: contextId,
      state: "completed",
      agentService: "test",
    })

    const v1 = Buffer.from("version 1")
    const v2 = Buffer.from("version 2 — the update")

    await store.saveOutputFile(taskId, "report.md", "text/markdown", v1)
    await store.saveOutputFile(taskId, "report.md", "text/markdown", v2)

    const rows = await SELECT.from(outputFiles).where({ up__ID: taskId, filename: "report.md" })
    expect(rows.length, "expected exactly one row after two saves of the same filename").toBe(1)

    const fetched = await store.getOutputFile(taskId, "report.md")
    expect(fetched.bytes.toString("utf-8")).toBe("version 2 — the update")
  })
})
