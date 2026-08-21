import { Readable } from "node:stream"
import { buffer as toBuffer } from "node:stream/consumers"
import cds from "@sap/cds"

const LOG = cds.log("agents")

/**
 * Resolve the user id used to scope input-file reads.
 */
function resolveUserId(explicit) {
  // REVISIT: most cases should just be using $user in the query
  if (explicit) return explicit
  return cds.context.user.id
}

function outputFilesEntity() {
  return cds.model.definitions["cap.agent.Tasks.outputFiles"]
}

/**
 * CDS-backed store for A2A file I/O using @cap-js/attachments composition children.
 */
export class CdsFileStore {
  // REVISIT: why is this asymmetrical from the save output files ?
  async saveInputFile(taskId, name, mimeType, bytesBuffer) {
    const { inputFiles } = cds.entities('cap.agent.Tasks')
    LOG.debug("Files: save input", { taskId, name, bytes: bytesBuffer.length })
    await INSERT.into(inputFiles).entries({
      ID: cds.utils.uuid(),
      up__taskId: taskId,
      filename: name,
      mimeType,
      content: Readable.from([bytesBuffer]),
    })
  }

  async getInputFile(contextId, name, userId) {
    const { inputFiles } = cds.entities('cap.agent.Tasks')
    const row = await SELECT.one
      .from`${inputFiles}[contextId=${contextId} and createdBy=$user]:inputFiles[filename=${name}]`
      .columns`filename, mimeType, content, length(content) as size`
      .orderBy`up_.createdAt desc, createdAt desc`

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
    const { Tasks } = cds.entities('cap.agent')
    return await SELECT.from`${Tasks}[contextId=${contextId} and createdBy=$user]:inputFiles as files`
      .columns`filename as name, mimeType, coalesce(length(content),0) as size`
      .where`createAt = ${// TODO: double check that the `files` alias works correctly
      SELECT.one.from`${Tasks}[contextId=${contextId} and createdBy=$user]:inputFiles`
        .where`filename = files.filename`
        .columns`max(createdAt)`
      }`
  }

  /**
   * Delete all input files for a context.
   */
  async deleteInputFiles(contextId, opts = {}) {
    const { inputFiles } = cds.entities('cap.agent.Tasks')
    const where = { "up_.contextId": contextId }
    if (!opts.allUsers) where["up_.createdBy"] = resolveUserId(opts.userId)
    await DELETE.from(inputFiles).where(where)
    LOG.debug("Files: deleted input files", { contextId, allUsers: !!opts.allUsers })
  }

  // REVISIT: this whole function is supposed to be a single UPSERT query,
  // but because the attachment plugin decided to give each attachment and UUID.
  // It is now not possible to simply UPSERT any attachment.
  // Consider to instead always INSERT and use createdAt to dedupe on read.
  async saveOutputFile(taskId, name, mimeType, bytesBuffer) {
    const { outputFiles } = cds.entities('cap.agent.Tasks')
    LOG.debug("Files: save output", { taskId, name, bytes: bytesBuffer.length })
    const existing = await SELECT.one
      .from(outputFiles)
      .columns("ID")
      .where({ up__taskId: taskId, filename: name })
    if (existing) {
      await UPDATE(outputFiles)
        .set({ mimeType, content: Readable.from([bytesBuffer]) })
        .where({ ID: existing.ID })
    } else {
      await INSERT.into(outputFiles).entries({
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
    const { Tasks } = cds.entities('cap.agent')
    return await SELECT.from`${Tasks}[taskId=${taskId}]`
      .columns`filename as name, mimeType, content`

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
    const { Tasks } = cds.entities('cap.agent')
    return await SELECT.from`${Tasks}[taskId=${taskId}]`
      .columns`filename as name, mimeType, coalesce(length(content), 0) as size`
  }

  async deleteOutputFiles(taskId) {
    const OutputFiles = outputFilesEntity()
    await DELETE.from(OutputFiles).where({ up__taskId: taskId })
    LOG.debug("Files: deleted output files", { taskId })
  }
}
