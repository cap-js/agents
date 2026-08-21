/**
 * UploadsBackend — deepagents BackendProtocolV2 implementation for /uploads/ route.
 *
 * Bridges deepagents' built-in read_file tool (which routes /uploads/* paths
 * through whatever backend is registered at '/uploads/' in CompositeBackend)
 * to cap.agent.Tasks.inputFiles via cds.ql. Without this backend, deepagents has no way
 * to honour /uploads/ paths at all — FilesystemMiddleware wires read_file
 * unconditionally to the backend.
 *
 */

import { getConfig } from "@langchain/langgraph"
import { isTextMime, globToRegex } from "./mime-utils.js"

export class UploadsBackend {
  constructor(fileStore) {
    this.fileStore = fileStore
  }

  _resolveContext() {
    const config = getConfig()
    const rawThreadId = config?.configurable?.thread_id || ""
    const contextId = rawThreadId.includes(":")
      ? rawThreadId.split(":").slice(1).join(":")
      : rawThreadId
    const userId = config?.configurable?._userId
    return { contextId, userId }
  }

  // CompositeBackend strips the route prefix (/uploads/) before delegating,
  // so paths arrive here as either "/name" (stripped) or "/uploads/name" (direct).
  // normalise() handles both forms.
  _name(filePath) {
    return filePath.replace(/^\/uploads\//, "").replace(/^\//, "")
  }

  async read(filePath, offset = 0, limit = 100) {
    const { contextId, userId } = this._resolveContext()
    const name = this._name(filePath)
    const file = await this.fileStore.getInputFile(contextId, name, userId)

    if (!file) {
      const available =
        (await this.fileStore.listInputFiles(contextId, userId))
          .map((f) => `/uploads/${f.name}`)
          .join(", ") || "none"
      return { error: `File not found: ${filePath}. Available: ${available}` }
    }

    if (file.mimeType?.startsWith("image/")) {
      return { error: `"${name}" is an image. Use an image analysis tool.` }
    }

    if (!isTextMime(file.mimeType)) {
      return { error: `"${name}" is a binary file (${file.mimeType}) — cannot be read as text.` }
    }

    const lines = (file.bytes ? file.bytes.toString("utf-8") : "").split("\n")
    return {
      content: lines.slice(offset, offset + limit).join("\n"),
      mimeType: file.mimeType,
    }
  }

  // Defensive stub for deepagents' BackendProtocolV2: callers that bypass the
  // text-only `read()` path (binary handling, future deepagents versions) hit
  // this method. Without it, `compositeBackend.readRaw('/uploads/<name>')`
  // throws `TypeError: backend.readRaw is not a function`. Currently unused
  // by our shipped code paths — do not delete as "dead".
  async readRaw(filePath) {
    const { contextId, userId } = this._resolveContext()
    const name = this._name(filePath)
    const file = await this.fileStore.getInputFile(contextId, name, userId)
    if (!file) return { error: `File not found: ${filePath}` }
    return { bytes: file.bytes, mimeType: file.mimeType, size: file.size }
  }

  // CompositeBackend re-prepends the route prefix to paths returned here,
  // so return bare "/<name>" paths (without /uploads/) to avoid double-prefix.
  async list(_dirPath) {
    const { contextId, userId } = this._resolveContext()
    const files = await this.fileStore.listInputFiles(contextId, userId)
    return files.map((f) => `/${f.name}`)
  }

  async ls(_path) {
    const { contextId, userId } = this._resolveContext()
    const files = await this.fileStore.listInputFiles(contextId, userId)
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
    const { contextId, userId } = this._resolveContext()
    const re = globToRegex(pattern)
    const files = await this.fileStore.listInputFiles(contextId, userId)
    return {
      files: files
        .filter((f) => re.test(f.name))
        .map((f) => ({ path: `/${f.name}`, is_dir: false, size: f.size, modified_at: "" })),
    }
  }

  async grep(pattern, _path, glob) {
    const { contextId, userId } = this._resolveContext()
    const reGlob = glob ? globToRegex(glob) : null
    const files = await this.fileStore.listInputFiles(contextId, userId)
    const candidates = files.filter(
      (f) => (!reGlob || reGlob.test(f.name)) && isTextMime(f.mimeType),
    )
    const fetched = await Promise.all(
      candidates.map((f) => this.fileStore.getInputFile(contextId, f.name, userId)),
    )
    const matches = []
    for (let i = 0; i < candidates.length; i++) {
      const file = fetched[i]
      if (!file) continue
      const lines = (file.bytes ? file.bytes.toString("utf-8") : "").split("\n")
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].includes(pattern)) {
          matches.push({
            path: `/${candidates[i].name}`,
            line: j + 1,
            text: lines[j],
          })
        }
      }
    }
    return { matches }
  }

  async exists(filePath) {
    const { contextId, userId } = this._resolveContext()
    const name = this._name(filePath)
    const file = await this.fileStore.getInputFile(contextId, name, userId)
    return !!file
  }

  async stat(filePath) {
    const { contextId, userId } = this._resolveContext()
    const name = this._name(filePath)
    const file = await this.fileStore.getInputFile(contextId, name, userId)
    if (!file) return null
    return { name: file.name, mimeType: file.mimeType, size: file.size }
  }

  write() {
    return { error: "read-only" }
  }

  edit() {
    return { error: "read-only — uploads cannot be edited" }
  }
}
