import { FilesystemBackend } from "deepagents"

export class ReadonlyBackend extends FilesystemBackend {
  write() {
    return { error: "read-only" }
  }

  edit() {
    return { error: "read-only" }
  }
}
