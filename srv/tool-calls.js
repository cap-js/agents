// srv/tool-calls.js — attachCqn helper used by chat.js when building toolCalls from messages.

import cds from "@sap/cds"

/**
 * If entry.args.cql is a string, parse it with cds.parse.cql and attach the
 * resulting CQN as a non-enumerable hidden `cqn` property on the entry.
 * Silently no-ops when cql is absent or unparseable.
 *
 *   entry.cqn.SELECT.from.ref[0]  // table name
 *   entry.cqn.SELECT.where        // WHERE clause
 */
export function attachCqn(entry) {
  const cql = entry.args?.cql
  if (typeof cql !== "string") return
  try {
    const cqn = cds.parse.cql(cql)
    Object.defineProperty(entry, "cqn", {
      value: cqn,
      enumerable: false,
      writable: false,
      configurable: true,
    })
  } catch {
    /* unparseable CQL — skip */
  }
}
