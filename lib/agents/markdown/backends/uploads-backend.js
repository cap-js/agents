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

import { isTextMime, globToRegex } from "./mime-utils.js"

export class UploadsBackend {
  constructor(contextId, fileStore, userId) {
    this.contextId = contextId
    this.fileStore = fileStore
    this.userId = userId
  }

  // CompositeBackend strips the route prefix (/uploads/) before delegating,
  // so paths arrive here as either "/name" (stripped) or "/uploads/name" (direct).
  // normalise() handles both forms.
  // REVISIT: is this really true ? What about "/uploads/uploads/" ?
  _name(filePath) {
    return filePath.replace(/^\/uploads\//, "").replace(/^\//, "")
  }

  async read(filePath, offset = 0, limit = 100) {
    const name = this._name(filePath)
    const file = await this.fileStore.getInputFile(this.contextId, name, this.userId)

    if (!file) {
      const available =
        (await this.fileStore.listInputFiles(this.contextId, this.userId))
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

    // REVISIT: `getInputFile` materializes the blob contents into memory
    // So for all the previous checks the `bytes` are loaded into memory and not used
    // Here the file contents are being used to cut out a specific subset of lines
    // Using a `for await` loop would perfectly allow this extraction
    // while only holding on to the subset of bytes that have to be returned here
    const lines = (file.bytes ? file.bytes.toString("utf-8") : "").split("\n")
    return {
      content: lines.slice(offset, offset + limit).join("\n"),
      mimeType: file.mimeType,
    }
  }

  // Defensive stub for deepagents' BackendProtocolV2: callers that bypass the
  // text-only `read()` path (binary handling, future deepagents versions) hit
  // this method. Without it, `compositeBackend.readRaw('/uploads/<name>')`
  // thrlineCountows `TypeError: backend.readRaw is not a function`. Currently unused
  // by our shipped code paths — do not delete as "dead".
  async readRaw(filePath) {
    const name = this._name(filePath)
    const file = await this.fileStore.getInputFile(this.contextId, name, this.userId)
    if (!file) return { error: `File not found: ${filePath}` }
    return { bytes: file.bytes, mimeType: file.mimeType, size: file.size }
  }

  // CompositeBackend re-prepends the route prefix to paths returned here,
  // so return bare "/<name>" paths (without /uploads/) to avoid double-prefix.
  // REVISIT: this comment says to drop the `uploads`, but the code does not do that
  async list(_dirPath) {
    const files = await this.fileStore.listInputFiles(this.contextId, this.userId)
    return files.map((f) => `/${f.name}`) // REVIIST: map is a copy could re use the original array
  }

  async ls(_path) {
    const files = await this.fileStore.listInputFiles(this.contextId, this.userId)
    return {
      // REVISIT: consider dropping the `fileStore` and simply use proper queries
      // that way you can just use `'/' || name as path` in the query instead
      files: files.map((f) => ({
        path: `/${f.name}`,
        is_dir: false,
        size: f.size,
        // not sure why modified_at was not filled
        modified_at: file.modifiedAt,
      })),
    }
  }

  async glob(pattern, _path) {
    const regex = globToRegex(pattern)
    const files = await this.fileStore.listInputFiles(this.contextId, this.userId)
    const matches = []
    for await (const file of files) { // use asyn iterator to not load the whole list into memory
      if (regex.test(file.name)) matches.push({
        path: `/${file.name}`,
        is_dir: false,
        size: file.size,
        modified_at: file.modifiedAt,
      })
    }
    return { files: matches }
  }

  async grep(pattern, _path, glob) {
    const reGlob = glob ? globToRegex(glob) : ''
    const regexMime = /^(text\/)/ // TODO: include the expected mime types

    const files = this.fileStore.getInputFiles(this.contextId, this.userId, {
      xpr: [
        ...(reGlob ? [{ ref: ['name'] }, 'like', reGlob, 'and'] : []),
        mimeType, 'like', regexMime,
      ]
    })

    const matches = []
    for await (const file of files) { // use asyn iterator to not load the whole list into memory
      if (!file.content) continue
      file.content.setEncoding('utf-8') // should not be really required

      let lineCount = 0
      let leftover = ''
      for await (const chunk of file.content) {
        const lines = (leftover + chunk).split('\n')
        leftover = lines.pop()
        for (const line of lines) match(line)
      }
      if (leftover) match(leftover)

      function match(line) {
        lineCount++
        if (line.includes(pattern)) matches.push({
          path: `/${file.name}`,
          line: lineCount,
          text: line,
        })
      }
    }
    return { matches }
  }

  async exists(filePath) {
    const name = this._name(filePath)
    // REVISIT: this currently downloads the whole file contents to check whether it exists
    const file = await this.fileStore.getInputFile(this.contextId, name, this.userId)
    return !!file
  }

  async stat(filePath) {
    const name = this._name(filePath)
    // REVISIT: this currently downloads the whole file contents to just get the metadata
    const file = await this.fileStore.getInputFile(this.contextId, name, this.userId)
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
