import cds from "@sap/cds"
import { short } from "../../../lib/utils/utils.js"
import { CdsFileStore } from "../../../lib/protocol/persistence/file-store.js"
import { formatFileSize, sanitizeFilename } from "../tools.js"

function checkInputFile(file, config) {
  const maxBytes = config?.maxInputFileSizeBytes
  if (maxBytes > 0 && typeof file?.bytes === "string") {
    const declared = Buffer.byteLength(file.bytes, "base64")
    if (declared > maxBytes) {
      return `exceeds size limit (${formatFileSize(declared)} > ${formatFileSize(maxBytes)})`
    }
  }
  const allowed = config?.defaultInputModes
  if (Array.isArray(allowed) && allowed.length > 0) {
    const mime = file?.mimeType || "application/octet-stream"
    if (!allowed.includes(mime)) return `mime type ${mime} not allowed`
  }
  return null
}

export function createFileStore() {
  return cds.env.agents?.fileIO?.enabled ? new CdsFileStore() : null
}

export async function persistInputFiles() {
  const { request: requestContext, fileStore } = cds.context?.agent || {}
  if (!fileStore) return
  const taskId = cds.context?.["agent.task.id"]
  const contextId = cds.context?.["agent.context.id"]
  const serviceName = cds.context?.["agent.service"]
  const log = cds.log("agents")
  const fileParts = requestContext.userMessage?.parts?.filter((part) => part.kind === "file") || []
  const manifestLines = await Promise.all(
    fileParts.map(async (filePart) => {
      const file = filePart.file || filePart
      if (file.bytes) {
        try {
          const safeName = sanitizeFilename(file.name)
          const safeMime = file.mimeType || "application/octet-stream"
          const rejection = checkInputFile({ ...file, mimeType: safeMime }, cds.env.agents?.fileIO)
          if (rejection) {
            log.warn(serviceName, "-", "input file rejected", {
              conversation: short(contextId),
              name: safeName,
              mimeType: safeMime,
              reason: rejection,
            })
            return `/uploads/${safeName} (rejected: ${rejection})`
          }
          const buffer = Buffer.from(file.bytes, "base64")
          await fileStore.saveInputFile(taskId, safeName, safeMime, buffer)
          log.info(serviceName, "-", "file uploaded", {
            conversation: short(contextId),
            name: safeName,
            mimeType: safeMime,
            size: buffer.length,
          })
          return `/uploads/${safeName} (${safeMime}, ${formatFileSize(buffer.length)})`
        } catch (error) {
          log.error("Failed to persist uploaded file", { name: file.name, error: error.message })
          return `/uploads/${sanitizeFilename(file.name)} (persist failed: ${error.message})`
        }
      }
      if (file.uri) return `${file.uri} (${file.mimeType || "unknown"}, URI reference)`
      return null
    }),
  )
  const validLines = manifestLines.filter(Boolean)
  if (validLines.length) requestContext._fileManifest = `[Uploaded files: ${validLines.join(", ")}]`
}

function collectInlineArtifacts(messages, maxFileBytes, { serviceName, contextId, log }) {
  const fileArtifacts = []
  const dataArtifacts = []
  const emitFilePartCallIds = new Set()
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      if (toolCall.name === "emit_file_part") emitFilePartCallIds.add(toolCall.id)
    }
  }
  for (const message of messages) {
    const fromEmitFilePart = !!(
      message.tool_call_id && emitFilePartCallIds.has(message.tool_call_id)
    )
    const content = typeof message.content === "string" ? message.content : ""
    let position = 0
    while (position < content.length) {
      const fileAt = content.indexOf('{"kind":"file"', position)
      const dataAt = content.indexOf('{"kind":"data"', position)
      const start = fileAt === -1 ? dataAt : dataAt === -1 ? fileAt : Math.min(fileAt, dataAt)
      if (start === -1) break
      let depth = 0
      let inString = false
      let index = start
      while (index < content.length) {
        const character = content[index]
        if (inString) {
          if (character === "\\") {
            index += 2
            continue
          }
          if (character === '"') inString = false
        } else if (character === '"') inString = true
        else if (character === "{") depth++
        else if (character === "}" && --depth === 0) break
        index++
      }
      try {
        const artifact = JSON.parse(content.slice(start, index + 1))
        if (artifact.kind === "data") dataArtifacts.push(artifact)
        else {
          const declaredBytes =
            typeof artifact.file?.bytes === "string"
              ? Buffer.byteLength(artifact.file.bytes, "base64")
              : 0
          if (declaredBytes > maxFileBytes) {
            log.warn(serviceName, "-", "emit_file_part artifact exceeds cap; skipping", {
              conversation: short(contextId),
              name: artifact.file?.name,
              size: declaredBytes,
              cap: maxFileBytes,
            })
          } else {
            if (fromEmitFilePart) artifact._fromEmitFilePart = true
            fileArtifacts.push(artifact)
          }
        }
      } catch {
        /* invalid embedded artifact */
      }
      position = index + 1
    }
  }
  return { fileArtifacts, dataArtifacts }
}

export async function publishOutputFiles({
  result,
  taskId,
  contextId,
  serviceName,
  eventBus,
  log,
  fileStore,
}) {
  const maxFileBytes = cds.env.agents.fileIO.maxOutputFileSizeBytes
  const { fileArtifacts, dataArtifacts } = collectInlineArtifacts(
    result.messages || [],
    maxFileBytes,
    { serviceName, contextId, log },
  )
  if (fileStore) {
    const inlineCount = fileArtifacts.length
    for (const meta of await fileStore.listOutputFilesMeta(taskId)) {
      if (meta.size > maxFileBytes) {
        log.warn(serviceName, "-", "output file exceeds cap; skipping", {
          conversation: short(contextId),
          name: meta.name,
          size: meta.size,
          cap: maxFileBytes,
        })
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      const file = await fileStore.getOutputFile(taskId, meta.name)
      if (file)
        fileArtifacts.push({
          kind: "file",
          file: { name: file.name, mimeType: file.mimeType, bytes: file.bytes.toString("base64") },
        })
    }
    await Promise.all(
      fileArtifacts
        .slice(0, inlineCount)
        .filter((artifact) => {
          if (!artifact.file?.bytes || !artifact.file?.name || artifact._fromEmitFilePart)
            return false
          const rejection = checkInputFile(artifact.file, cds.env.agents?.fileIO)
          if (!rejection) return true
          log.warn(serviceName, "-", "downstream file re-persist rejected", {
            conversation: short(contextId),
            name: artifact.file.name,
            reason: rejection,
          })
          return false
        })
        .map((artifact) =>
          fileStore.saveInputFile(
            taskId,
            sanitizeFilename(artifact.file.name),
            artifact.file.mimeType,
            Buffer.from(artifact.file.bytes, "base64"),
          ),
        ),
    )
  }
  for (const filePart of fileArtifacts) {
    if (!filePart.file?.name) {
      log.warn(serviceName, "-", "skipping malformed file artifact", {
        conversation: short(contextId),
      })
      continue
    }
    const source = filePart._fromEmitFilePart ? "emit_file_part" : "outputs/"
    delete filePart._fromEmitFilePart
    const safeName = sanitizeFilename(filePart.file.name)
    const bytes =
      typeof filePart.file.bytes === "string" ? Buffer.byteLength(filePart.file.bytes, "base64") : 0
    log.info(serviceName, "-", "file emitted", {
      conversation: short(contextId),
      name: safeName,
      mimeType: filePart.file.mimeType,
      bytes,
      source,
    })
    eventBus.publish({
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: { artifactId: `file-${safeName}`, name: safeName, parts: [filePart] },
    })
  }
  dataArtifacts.forEach((artifact, index) => {
    if (artifact.data == null || typeof artifact.data !== "object") {
      log.warn(serviceName, "-", "skipping malformed data artifact", {
        conversation: short(contextId),
      })
      return
    }
    log.info(serviceName, "-", "data emitted", { conversation: short(contextId) })
    eventBus.publish({
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: { artifactId: `data-${index}`, parts: [{ kind: "data", data: artifact.data }] },
    })
  })
}
