/* eslint-disable no-await-in-loop */
import cds from "@sap/cds"
import { createHash } from "node:crypto"

const MESSAGES = "cap.agent.Messages"
const SESSIONS = "cap.agent.Sessions"
const COLUMNS = [
  "ID",
  "session",
  "sequence",
  "prev_ID",
  "role",
  "type",
  "scope",
  "stream",
  "category",
  "sortKey",
  "query",
  "content",
]
const transactionQueues = new WeakMap()

export const currentOwner = () => cds.context?.user?.id ?? "anonymous"

// UUIDv8: deterministic application-defined identities, independent of process lifetime.
export function recordId(...parts) {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function sessionId(id) {
  if (typeof id !== "string" || !id) throw new Error("A nonempty session identifier is required")
  // CAP's service-scoped conversation IDs end in the original A2A contextId.
  const uuid = /(?:^|:)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(id)?.[1]
  return uuid ? uuid.toLowerCase() : recordId("session", id)
}

/** Generic persistence for owner-scoped, ordered messages. */
export class CdsMessageStore {
  async get(ID) {
    return (await this.getMany([ID]))[0]
  }

  async getMany(ids, columns = COLUMNS) {
    const unique = [...new Set(ids)]
    const rows = []
    for (let i = 0; i < unique.length; i += 500) {
      rows.push(
        ...(await SELECT.from(MESSAGES)
          .columns(...columns)
          .where({ ID: { in: unique.slice(i, i + 500) }, createdBy: currentOwner() })),
      )
    }
    return rows
  }

  async *list(where = {}, columns = COLUMNS) {
    let after
    const owner = currentOwner()
    while (true) {
      const rows = await SELECT.from(MESSAGES)
        .columns(...columns)
        .where({ ...where, createdBy: owner, ...(after ? { ID: { ">": after } } : {}) })
        .orderBy("ID")
        .limit(100)
      yield* rows
      if (rows.length < 100) return
      after = rows.at(-1).ID
    }
  }

  async *ordered(where, { before, limit = Infinity } = {}) {
    let cursor
    let remaining = limit
    while (remaining > 0) {
      const query = SELECT.from(MESSAGES)
        .columns(...COLUMNS)
        .where({ ...where, createdBy: currentOwner() })
        .orderBy("sortKey desc", "ID desc")
        .limit(Math.min(100, remaining))
      if (before !== undefined) query.and({ sortKey: { "<": before } })
      if (cursor)
        query.and([
          { ref: ["sortKey"] },
          "<",
          { val: cursor.sortKey },
          "or",
          "(",
          { ref: ["sortKey"] },
          "=",
          { val: cursor.sortKey },
          "and",
          { ref: ["ID"] },
          "<",
          { val: cursor.ID },
          ")",
        ])
      const rows = await query
      yield* rows
      remaining -= rows.length
      if (rows.length < 100) return
      cursor = rows.at(-1)
    }
  }

  async preceding(where, sequence, limit = 64) {
    return SELECT.from(MESSAGES)
      .columns(...COLUMNS)
      .where({ ...where, createdBy: currentOwner(), sequence: { "<=": sequence } })
      .orderBy("sequence desc")
      .limit(limit)
  }

  async mutate(id, fn) {
    const ID = sessionId(id)
    const owner = currentOwner()
    const run = async (tx) => {
      await tx.run(UPSERT.into(SESSIONS).entries({ ID, owner }))
      const session = await tx.run(SELECT.one.from(SESSIONS).where({ ID, owner }).forUpdate())
      // Old sessions initialize their counter once; normal appends never scan history.
      let sequence = session.sequence
      if (sequence == null) {
        const last = await tx.run(
          SELECT.one
            .from(MESSAGES)
            .columns("max(sequence) as sequence")
            .where({ session: ID, createdBy: owner }),
        )
        sequence = last?.sequence ?? 0
      }
      sequence = Number(sequence)
      const putMany = async (messages, { overwrite = true, knownNew = false } = {}) => {
        const unique = new Map()
        for (const message of messages) {
          if (overwrite || !unique.has(message.ID)) unique.set(message.ID, message)
        }
        const existing = new Map(
          (knownNew ? [] : await this.getMany([...unique.keys()], ["ID", "sequence"])).map(
            (row) => [row.ID, row],
          ),
        )
        const entries = []
        for (const message of unique.values()) {
          const previous = existing.get(message.ID)
          if (previous && !overwrite) continue
          entries.push({
            ...message,
            session: ID,
            sequence: previous?.sequence ?? ++sequence,
            createdBy: owner,
          })
        }
        for (let i = 0; i < entries.length; i += 500) {
          await tx.run(UPSERT.into(MESSAGES).entries(entries.slice(i, i + 500)))
        }
      }
      const result = await fn({
        getMany: (ids, columns) => this.getMany(ids, columns),
        putMany,
        put: (message, options) => putMany([message], options),
      })
      await tx.run(UPDATE(SESSIONS).set({ sequence }).where({ ID, owner }))
      return result
    }
    if (!cds.context?.tx) return cds.tx(run)
    const tx = cds.tx(cds.context)
    // Row locks are reentrant within a transaction; also serialize its concurrent callers.
    const operation = (transactionQueues.get(tx) ?? Promise.resolve()).then(() => run(tx))
    transactionQueues.set(
      tx,
      operation.catch(() => {}),
    )
    return operation
  }

  async deleteSession(id, where = {}) {
    await this.mutate(id, async () => {
      await DELETE.from(MESSAGES).where({
        ...where,
        session: sessionId(id),
        createdBy: currentOwner(),
      })
      const remaining = await SELECT.one
        .from(MESSAGES)
        .columns("ID")
        .where({ session: sessionId(id), createdBy: currentOwner() })
      if (!remaining)
        await DELETE.from(SESSIONS).where({ ID: sessionId(id), owner: currentOwner() })
    })
  }
}
