import { Readable } from "node:stream"
import cds from "@sap/cds"

const LOG = cds.log("agents")

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
  const { Messages } = cds.entities("cap.agent")
  return Messages.elements.inputFiles._target
}

function outputFilesEntity() {
  const { Messages } = cds.entities("cap.agent")
  return Messages.elements.outputFiles._target
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
      up__ID: taskId,
      filename: name,
      mimeType,
      content: Readable.from([bytesBuffer]),
    })
  }

  async getInputFile(contextId, name) {
    const InputFiles = inputFilesEntity()
    const row = await cds.ql.SELECT.one`from ${InputFiles} { ID, filename, mimeType, content }
      where up_.session = ${contextId} and up_.createdBy = $user.id and filename = ${name}
      order by up_.createdAt desc, createdAt desc`

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

  async listInputFiles(contextId) {
    const InputFiles = inputFilesEntity()
    const rows = await cds.ql.SELECT`from ${InputFiles} {
        ID, filename, mimeType, createdAt, up_.createdAt as taskCreatedAt, length(content) as size
      } where up_.session = ${contextId} and up_.createdBy = $user.id
      order by up_.createdAt desc, createdAt desc`

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
    let query = DELETE.from(InputFiles).where`up_.session = ${contextId}`
    if (!opts.allUsers) query = query.and`up_.createdBy = $user.id`
    await query
    LOG.debug("Files: deleted input files", { contextId, allUsers: !!opts.allUsers })
  }

  async saveOutputFile(taskId, name, mimeType, bytesBuffer) {
    const OutputFiles = outputFilesEntity()
    LOG.debug("Files: save output", { taskId, name, bytes: bytesBuffer.length })
    const existing = await cds.ql.SELECT.one`from ${OutputFiles} { ID }
      where up__ID = ${taskId} and filename = ${name}`
    if (existing) {
      await UPDATE(OutputFiles).set({ mimeType, content: Readable.from([bytesBuffer]) })
        .where`ID = ${existing.ID}`
    } else {
      await INSERT.into(OutputFiles).entries({
        ID: cds.utils.uuid(),
        up__ID: taskId,
        filename: name,
        mimeType,
        content: Readable.from([bytesBuffer]),
      })
    }
  }

  async getOutputFile(taskId, name) {
    const OutputFiles = outputFilesEntity()
    const row = await cds.ql.SELECT.one`from ${OutputFiles} { ID, filename, mimeType, content }
      where up__ID = ${taskId} and filename = ${name}
      order by createdAt desc`

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
    const rows = await cds.ql.SELECT`from ${OutputFiles} { ID, filename, mimeType, content }
      where up__ID = ${taskId}`

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
    const rows = await cds.ql.SELECT`from ${OutputFiles} {
        ID, filename, mimeType, length(content) as size
      } where up__ID = ${taskId}`

    return rows.map((r) => ({
      name: r.filename,
      mimeType: r.mimeType,
      size: r.size ?? 0,
    }))
  }

  async deleteOutputFiles(taskId) {
    const OutputFiles = outputFilesEntity()
    await DELETE.from(OutputFiles).where`up__ID = ${taskId}`
    LOG.debug("Files: deleted output files", { taskId })
  }
}
