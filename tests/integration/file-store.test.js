// Integration tests for CdsFileStore against a running CDS runtime.
// Exercise composition cascade-delete via @cap-js/attachments and the
// HANA-driver-defeating upsert pattern in saveOutputFile.

import path from "node:path"
import { fileURLToPath } from "node:url"
import cds from "@sap/cds"
import { CdsFileStore } from "../../lib/protocol/persistence/file-store.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// side-effect: registers in-memory CDS bootstrap for the integration tests
cds.test(path.join(__dirname, "../samples/bookshop"))

describe("@cap-js/agent - composition cascade delete", () => {
  it("deleting a Tasks row removes its inputFiles children", async () => {
    await cds.connect.to("db")
    const InputFiles = cds.model.definitions["cap.agent.Tasks.inputFiles"]

    const taskId = cds.utils.uuid()
    const contextId = cds.utils.uuid()

    // Insert parent Tasks row
    await INSERT.into("cap.agent.Tasks").entries({
      taskId,
      contextId,
      state: "completed",
      data: "{}",
      agentService: "test",
    })

    // Insert child inputFiles row directly (bypassing attachments for test isolation)
    await INSERT.into(InputFiles).entries({
      ID: cds.utils.uuid(),
      up__taskId: taskId,
      filename: "test.csv",
      mimeType: "text/csv",
    })

    // Verify child exists
    const beforeRows = await SELECT.from(InputFiles).where({ up__taskId: taskId })
    expect(beforeRows.length).toBe(1)

    // Delete parent
    await DELETE.from("cap.agent.Tasks").where({ taskId })

    // Child must be gone (cascade delete via composition)
    const after = await SELECT.from(InputFiles).where({ up__taskId: taskId })
    expect(after.length).toBe(0)
  })
})

describe("@cap-js/agent - CdsFileStore.saveOutputFile upsert", () => {
  it("second saveOutputFile call for same (taskId, filename) updates the row, not inserts", async () => {
    await cds.connect.to("db")
    const OutputFiles = cds.model.definitions["cap.agent.Tasks.outputFiles"]
    const store = new CdsFileStore()

    const taskId = cds.utils.uuid()
    const contextId = cds.utils.uuid()

    // Insert parent Tasks row (FK requirement)
    await INSERT.into("cap.agent.Tasks").entries({
      taskId,
      contextId,
      state: "completed",
      data: "{}",
      agentService: "test",
    })

    const v1 = Buffer.from("version 1")
    const v2 = Buffer.from("version 2 — the update")

    await store.saveOutputFile(taskId, "report.md", "text/markdown", v1)
    await store.saveOutputFile(taskId, "report.md", "text/markdown", v2)

    const rows = await SELECT.from(OutputFiles).where({ up__taskId: taskId, filename: "report.md" })
    expect(rows.length, "expected exactly one row after two saves of the same filename").toBe(1)

    const fetched = await store.getOutputFile(taskId, "report.md")
    expect(fetched.bytes.toString("utf-8")).toBe("version 2 — the update")
  })
})
