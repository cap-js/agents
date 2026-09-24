import { FilesystemBackend } from "deepagents"

export class ReadonlyBackend {
  constructor(options) {
    // explicitly keep this internal (no class inheritance) so we do not expose write operations
    this._fsBackend = new FilesystemBackend(options)
  }

  ls(path) {
    return this._fsBackend.ls(path)
  }

  read(filePath, offset, limit) {
    return this._fsBackend.read(filePath, offset, limit)
  }

  readRaw(filePath) {
    return this._fsBackend.readRaw(filePath)
  }

  grep(pattern, path, glob, maxCount) {
    return this._fsBackend.grep(pattern, path, glob, maxCount)
  }

  glob(pattern, path) {
    return this._fsBackend.glob(pattern, path)
  }

  downloadFiles(paths) {
    return this._fsBackend.downloadFiles(paths)
  }

  write() {
    return { error: "read-only" }
  }

  edit() {
    return { error: "read-only" }
  }

  delete() {
    return { error: "read-only" }
  }

  uploadFiles() {
    return { error: "read-only" }
  }
}
