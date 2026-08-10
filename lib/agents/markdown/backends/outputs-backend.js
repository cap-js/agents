/**
 * OutputsBackend — deepagents BackendProtocolV2 implementation for /outputs/ route.
 *
 * Creative reuse of deepagents' existing write_file tool: instead of adding
 * an emit_file_part tool to the deep agent's tool set, the executor routes
 * /outputs/ writes (which the agent makes via the standard write_file tool)
 * to cap.agent.Tasks.outputFiles in CDS. After invocation, the executor reads all output
 * files for the task from cap.agent.Tasks.outputFiles and emits them as A2A FileParts.
 *
 */

import { isTextMime, globToRegex } from "./mime-utils.js"

function inferMimeType(name) {
  const ext = name?.split(".").pop()?.toLowerCase()
  const map = {
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    js: "application/javascript",
    ts: "text/typescript",
    py: "text/x-python",
    sql: "application/sql",
  }
  return map[ext] || "application/octet-stream"
}

export class OutputsBackend {
  constructor(taskId, fileStore) {
    this.taskId = taskId
    this.fileStore = fileStore
  }

  // CompositeBackend strips the route prefix (/outputs/) before delegating,
  // so paths arrive here as either "/name" (stripped) or "/outputs/name" (direct).
  // _name() handles both forms.
  _name(filePath) {
    return filePath.replace(/^\/outputs\//, "").replace(/^\//, "")
  }

  async write(filePath, content, options = {}) {
    const name = this._name(filePath)
    const mimeType = options.mimeType || inferMimeType(name)
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content)
    await this.fileStore.saveOutputFile(this.taskId, name, mimeType, buf)
    return { success: true }
  }

  async exists(filePath) {
    const name = this._name(filePath)
    const files = await this.fileStore.listOutputFilesMeta(this.taskId)
    return files.some((f) => f.name === name)
  }

  async stat(filePath) {
    const name = this._name(filePath)
    const files = await this.fileStore.listOutputFilesMeta(this.taskId)
    const file = files.find((f) => f.name === name)
    if (!file) return null
    return { name: file.name, mimeType: file.mimeType, size: file.size }
  }

  // CompositeBackend re-prepends the route prefix to paths returned here,
  // so return bare "/<name>" paths (without /outputs/) to avoid double-prefix.
  async list(_dirPath) {
    const files = await this.fileStore.listOutputFilesMeta(this.taskId)
    return files.map((f) => `/${f.name}`)
  }

  async ls(_path) {
    const files = await this.fileStore.listOutputFilesMeta(this.taskId)
    return {
      files: files.map((f) => ({
        path: `/${f.name}`,
        is_dir: false,
        size: f.size,
        modified_at: "",
      })),
    }
  }

  async glob(pattern, _path) {
    const re = globToRegex(pattern)
    const files = await this.fileStore.listOutputFilesMeta(this.taskId)
    return {
      files: files
        .filter((f) => re.test(f.name))
        .map((f) => ({ path: `/${f.name}`, is_dir: false, size: f.size, modified_at: "" })),
    }
  }

  async grep(pattern, _path, glob) {
    const reGlob = glob ? globToRegex(glob) : null
    const files = await this.fileStore.listOutputFiles(this.taskId)
    const matches = []
    for (const f of files) {
      if (reGlob && !reGlob.test(f.name)) continue
      if (!isTextMime(f.mimeType)) continue
      const lines = (f.bytes ? Buffer.from(f.bytes).toString("utf-8") : "").split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({ path: `/${f.name}`, line: i + 1, text: lines[i] })
        }
      }
    }
    return { matches }
  }

  async read(filePath, offset = 0, limit = 100) {
    const name = this._name(filePath)
    const file = await this.fileStore.getOutputFile(this.taskId, name)
    if (!file) {
      const files = await this.fileStore.listOutputFilesMeta(this.taskId)
      const available = files.map((f) => `/outputs/${f.name}`).join(", ") || "none"
      return { error: `File not found: ${filePath}. Available: ${available}` }
    }
    if (!isTextMime(file.mimeType)) {
      return { error: `"${name}" is a binary file (${file.mimeType}) — cannot be read as text.` }
    }
    const text = file.bytes ? Buffer.from(file.bytes).toString("utf-8") : ""
    const lines = text.split("\n")
    return {
      content: lines.slice(offset, offset + limit).join("\n"),
      mimeType: file.mimeType,
    }
  }

  // Defensive stub for deepagents' BackendProtocolV2 — see UploadsBackend.readRaw
  // for the rationale. Currently unused by our shipped code paths; do not delete.
  async readRaw(filePath) {
    const name = this._name(filePath)
    const file = await this.fileStore.getOutputFile(this.taskId, name)
    if (!file) return { error: `File not found: ${filePath}` }
    return { bytes: file.bytes, mimeType: file.mimeType, size: file.size }
  }

  edit() {
    return { error: "use write_file to overwrite an output file" }
  }
}
