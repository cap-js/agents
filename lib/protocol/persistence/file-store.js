import { Readable } from "node:stream"
import cds from "@sap/cds"

const LOG = cds.log("agent")

/**
 * Resolve the user id used to scope input-file reads.
 */
function resolveUserId(explicit) {
  if (explicit) return explicit
  return cds.context.user.id
}

/**
 * Consume a Readable stream into a Buffer.
 */
async function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value && typeof value.pipe === "function") {
    return new Promise((resolve, reject) => {
      const chunks = []
      value.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      value.on("end", () => resolve(Buffer.concat(chunks)))
      value.on("error", reject)
    })
  }
  if (value == null) return Buffer.alloc(0)
  return Buffer.from(value)
}

function inputFilesEntity() {
  return cds.model.definitions["cap.agent.Tasks.inputFiles"]
}

function outputFilesEntity() {
  return cds.model.definitions["cap.agent.Tasks.outputFiles"]
}

/**
 * CDS-backed store for A2A file I/O using @cap-js/attachments composition children.
 */
export class CdsFileStore {
  async saveInputFile(taskId, name, mimeType, bytesBuffer) {
    const InputFiles = inputFilesEntity()
    LOG.debug("Files: save input", { taskId, name, bytes: bytesBuffer.length })
    await INSERT.into(InputFiles).entries({
      ID: cds.utils.uuid(),
      up__taskId: taskId,
      filename: name,
      mimeType,
      content: Readable.from([bytesBuffer]),
    })
  }

  async getInputFile(contextId, name, userId) {
    const InputFiles = inputFilesEntity()
    const row = await SELECT.one
      .from(InputFiles)
      .columns("ID", "filename", "mimeType", "content")
      .where({ "up_.contextId": contextId, "up_.createdBy": resolveUserId(userId), filename: name })
      .orderBy([
        { ref: ["up_", "createdAt"], sort: "desc" },
        { ref: ["createdAt"], sort: "desc" },
      ])

    if (!row) {
      LOG.debug("Files: get input miss", { contextId, name })
      return null
    }

    const bytes = await toBuffer(row.content)
    LOG.debug("Files: get input hit", { contextId, name, size: bytes.length })
    return {
      name: row.filename,
      mimeType: row.mimeType,
      bytes,
      size: bytes.length,
    }
  }

  async listInputFiles(contextId, userId) {
    const InputFiles = inputFilesEntity()
    const rows = await SELECT.from(InputFiles)
      .columns(
        "ID",
        "filename",
        "mimeType",
        "createdAt",
        { ref: ["up_", "createdAt"], as: "taskCreatedAt" },
        { func: "length", args: [{ ref: ["content"] }], as: "size" },
      )
      .where({ "up_.contextId": contextId, "up_.createdBy": resolveUserId(userId) })
      .orderBy([
        { ref: ["up_", "createdAt"], sort: "desc" },
        { ref: ["createdAt"], sort: "desc" },
      ])

    // JS dedupe by filename keeping latest (first in desc order)
    const seen = new Map()
    for (const row of rows) {
      if (!seen.has(row.filename)) seen.set(row.filename, row)
    }
    return [...seen.values()].map((r) => ({
      name: r.filename,
      mimeType: r.mimeType,
      size: r.size ?? 0,
    }))
  }

  /**
   * Delete all input files for a context.
   */
  async deleteInputFiles(contextId, opts = {}) {
    const InputFiles = inputFilesEntity()
    const where = { "up_.contextId": contextId }
    if (!opts.allUsers) where["up_.createdBy"] = resolveUserId(opts.userId)
    await DELETE.from(InputFiles).where(where)
    LOG.debug("Files: deleted input files", { contextId, allUsers: !!opts.allUsers })
  }

  async saveOutputFile(taskId, name, mimeType, bytesBuffer) {
    const OutputFiles = outputFilesEntity()
    LOG.debug("Files: save output", { taskId, name, bytes: bytesBuffer.length })
    const existing = await SELECT.one
      .from(OutputFiles)
      .columns("ID")
      .where({ up__taskId: taskId, filename: name })
    if (existing) {
      await UPDATE(OutputFiles)
        .set({ mimeType, content: Readable.from([bytesBuffer]) })
        .where({ ID: existing.ID })
    } else {
      await INSERT.into(OutputFiles).entries({
        ID: cds.utils.uuid(),
        up__taskId: taskId,
        filename: name,
        mimeType,
        content: Readable.from([bytesBuffer]),
      })
    }
  }

  async getOutputFile(taskId, name) {
    const OutputFiles = outputFilesEntity()
    const row = await SELECT.one
      .from(OutputFiles)
      .columns("ID", "filename", "mimeType", "content")
      .where({ up__taskId: taskId, filename: name })
      .orderBy([{ ref: ["createdAt"], sort: "desc" }])

    if (!row) {
      LOG.debug("Files: get output miss", { taskId, name })
      return null
    }

    const bytes = await toBuffer(row.content)
    return {
      name: row.filename,
      mimeType: row.mimeType,
      bytes,
      size: bytes.length,
    }
  }

  async listOutputFiles(taskId) {
    const OutputFiles = outputFilesEntity()
    const rows = await SELECT.from(OutputFiles)
      .columns("ID", "filename", "mimeType", "content")
      .where({ up__taskId: taskId })

    return Promise.all(
      rows.map(async (row) => {
        const bytes = await toBuffer(row.content)
        return {
          name: row.filename,
          mimeType: row.mimeType,
          bytes,
          size: bytes.length,
        }
      }),
    )
  }

  /**
   * List output file metadata for a task without fetching content bytes.
   */
  async listOutputFilesMeta(taskId) {
    const OutputFiles = outputFilesEntity()
    const rows = await SELECT.from(OutputFiles)
      .columns("ID", "filename", "mimeType", {
        func: "length",
        args: [{ ref: ["content"] }],
        as: "size",
      })
      .where({ up__taskId: taskId })

    return rows.map((r) => ({
      name: r.filename,
      mimeType: r.mimeType,
      size: r.size ?? 0,
    }))
  }

  async deleteOutputFiles(taskId) {
    const OutputFiles = outputFilesEntity()
    await DELETE.from(OutputFiles).where({ up__taskId: taskId })
    LOG.debug("Files: deleted output files", { taskId })
  }
}
