/* eslint-disable no-await-in-loop */
import { createHash } from "node:crypto"

const INLINE = 512
const MIN_CHUNK = 1024
const MAX_CHUNK = 16384
// A fixed gear table makes boundaries independent of process and serializer.
const GEAR = Array.from({ length: 256 }, (_, i) =>
  createHash("sha256").update(String(i)).digest().readUInt32LE(),
)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

function* chunks(bytes) {
  let start = 0
  let gear = 0
  for (let i = 0; i < bytes.length; i++) {
    gear = ((gear << 1) + GEAR[bytes[i]]) >>> 0
    const size = i + 1 - start
    if (size >= MIN_CHUNK && ((gear & 4095) === 0 || size >= MAX_CHUNK)) {
      yield bytes.subarray(start, i + 1)
      start = i + 1
      gear = 0
    }
  }
  if (start < bytes.length) yield bytes.subarray(start)
}

/** Immutable, content-defined chunks and a persistent sequence tree in Messages.
 * No snapshot contains a growing flat list of references. Trees share unchanged
 * subtrees, including after insertions near the beginning of a serialized value.
 */
export class SharedContent {
  constructor(store, serde, identify, message) {
    Object.assign(this, { store, serde, identify, message })
  }

  async dump(value, plan) {
    const [type, serialized] = await this.serde.dumpsTyped(value)
    const bytes = Buffer.from(serialized)
    if (bytes.length <= INLINE) return JSON.stringify([type, bytes.toString("base64")])
    const stack = []
    const occurrences = new Map()
    for (const chunk of chunks(bytes)) {
      const digest = hash(chunk)
      const chunkID = this.identify("chunk", digest)
      plan.set(chunkID, {
        row: this.message(chunkID, "chunk", JSON.stringify(["chunk", chunk.toString("base64")])),
        children: [],
      })
      const occurrence = occurrences.get(digest) ?? 0
      occurrences.set(digest, occurrence + 1)
      // Duplicate chunks need distinct priorities to avoid a linear-depth tree.
      const node = {
        chunk: chunkID,
        priority: hash(`${digest}:${occurrence}`),
        left: null,
        right: null,
      }
      while (stack.length && stack.at(-1).priority > node.priority) node.left = stack.pop()
      if (stack.length) stack.at(-1).right = node
      stack.push(node)
    }
    const root = stack[0]
    // Iterative postorder: bounded call-stack use even for adversarial input.
    const pending = [[root, false]]
    while (pending.length) {
      const [node, visited] = pending.pop()
      if (!visited) {
        pending.push([node, true])
        if (node.right) pending.push([node.right, false])
        if (node.left) pending.push([node.left, false])
        continue
      }
      const content = JSON.stringify([
        "node",
        node.chunk,
        node.left?.ID ?? null,
        node.right?.ID ?? null,
      ])
      node.ID = this.identify("node", hash(content))
      plan.set(node.ID, {
        row: this.message(node.ID, "node", content),
        children: [node.chunk, node.left?.ID, node.right?.ID].filter(Boolean),
      })
    }
    return JSON.stringify([type, { format: "chunks/1", root: root.ID, size: bytes.length }])
  }

  async persist(plan, contents, writer) {
    let frontier = contents
      .filter(Boolean)
      .map((content) => JSON.parse(content)[1]?.root)
      .filter(Boolean)
    const seen = new Set()
    const missing = []
    while (frontier.length) {
      const ids = [...new Set(frontier)].filter((id) => !seen.has(id))
      ids.forEach((id) => seen.add(id))
      const existing = new Set((await writer.getMany(ids, ["ID"])).map((row) => row.ID))
      frontier = []
      for (const id of ids) {
        if (existing.has(id)) continue // Existing subtree: no traversal or reads of its descendants.
        const item = plan.get(id)
        if (!item) throw new Error(`Missing content plan: ${id}`)
        missing.push(item.row)
        frontier.push(...item.children)
      }
    }
    await writer.putMany(missing, { knownNew: true, overwrite: false })
  }

  async loadMany(contents) {
    const envelopes = contents.map((content) => JSON.parse(content))
    const records = new Map()
    let frontier = envelopes.map(([, data]) => data?.root).filter(Boolean)
    while (frontier.length) {
      const ids = [...new Set(frontier)].filter((id) => !records.has(id))
      const rows = await this.store.getMany(ids, ["ID", "content"])
      if (rows.length !== ids.length) throw new Error("Missing shared message content")
      frontier = []
      for (const row of rows) {
        const entry = JSON.parse(row.content)
        records.set(row.ID, entry)
        if (entry[0] === "node") frontier.push(...entry.slice(1).filter(Boolean))
        else if (entry[0] !== "chunk") throw new Error("Invalid shared message content")
      }
    }
    return Promise.all(
      envelopes.map(async ([type, data]) => {
        let bytes
        if (typeof data === "string") bytes = Buffer.from(data, "base64")
        else {
          if (data?.format !== "chunks/1") throw new Error("Unsupported shared message content")
          const parts = []
          const pending = [data.root]
          while (pending.length) {
            const entry = records.get(pending.pop())
            if (entry[0] === "chunk") parts.push(Buffer.from(entry[1], "base64"))
            else {
              if (entry[3]) pending.push(entry[3])
              pending.push(entry[1])
              if (entry[2]) pending.push(entry[2])
            }
          }
          bytes = Buffer.concat(parts)
          if (bytes.length !== data.size) throw new Error("Shared message content length mismatch")
        }
        return this.serde.loadsTyped(type, new Uint8Array(bytes))
      }),
    )
  }
}
