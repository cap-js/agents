/* eslint-disable no-await-in-loop */
import { isDeepStrictEqual } from "node:util"
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  TASKS,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  writesSortKey,
} from "@langchain/langgraph-checkpoint"
import { CdsMessageStore, currentOwner, recordId } from "./message-store.js"
import { SharedContent } from "./shared-content.js"

const FORMAT = "langgraph-checkpoint/1"
const configFor = (thread, namespace, id) => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: id },
})
const identity = (kind, thread, namespace, ...parts) =>
  recordId(FORMAT, currentOwner(), kind, thread, namespace, ...parts)
const scopeFor = (thread) => identity("scope", thread, "")
const streamFor = (thread, namespace) => identity("stream", thread, namespace)
const isRecord = (row, kind) => row?.query?.format === FORMAT && row.query.kind === kind
const compareWrites = (a, b) =>
  compareWritesSortKeys(
    writesSortKey(a.query.path, a.query.task, a.query.index),
    writesSortKey(b.query.path, b.query.task, b.query.index),
  )

/** LangGraph adapter over the generic Messages/Sessions model. */
export class CdsCheckpointSaver extends BaseCheckpointSaver {
  store = new CdsMessageStore()

  _content(thread) {
    return new SharedContent(
      this.store,
      this.serde,
      (kind, digest) => identity(kind, thread, "", digest),
      (ID, kind, content) => this._message(ID, { kind, thread }, content),
    )
  }

  async _load(content) {
    return (await this._content().loadMany([content]))[0]
  }

  _message(ID, query, content, prev_ID = null) {
    return {
      ID,
      scope: scopeFor(query.thread),
      stream: query.namespace === undefined ? null : streamFor(query.thread, query.namespace),
      category: query.kind,
      sortKey: query.kind === "checkpoint" ? query.id : null,
      role: "system",
      type: "data",
      query: { format: FORMAT, ...query },
      content,
      prev_ID,
    }
  }

  async _writes(thread, namespace, id) {
    const rows = []
    for await (const row of this.store.list({
      prev_ID: identity("checkpoint", thread, namespace, id),
      category: "write",
    })) {
      if (isRecord(row, "write")) rows.push(row)
    }
    rows.sort(compareWrites)
    const values = await this._content().loadMany(rows.map((row) => row.content))
    return rows.map((row, i) => [row.query.task, row.query.channel, values[i]])
  }

  async _tuple(row, loaded) {
    const { thread, namespace, id, parent } = row.query
    const { checkpoint, metadata } = loaded ?? (await this._load(row.content))
    const channels = Object.entries(checkpoint.channel_versions)
    const rows = await this.store.getMany(
      channels.map(([channel, version]) =>
        identity("value", thread, namespace, channel, String(version)),
      ),
    )
    const present = rows.filter((value) => isRecord(value, "value") && !value.query.empty)
    const values = await this._content().loadMany(present.map((value) => value.content))
    checkpoint.channel_values = Object.fromEntries(
      present.map((value, i) => [value.query.channel, values[i]]),
    )
    const pendingWrites = await this._writes(thread, namespace, id)
    if (checkpoint.v < 4 && parent !== undefined) {
      const sends = await this._writes(thread, namespace, parent)
      checkpoint.channel_values[TASKS] = sends
        .filter(([, channel]) => channel === TASKS)
        .map(([, , value]) => value)
      const versions = Object.values(checkpoint.channel_versions)
      checkpoint.channel_versions[TASKS] = versions.length ? maxChannelVersion(...versions) : 1
    }
    return {
      config: configFor(thread, namespace, id),
      checkpoint,
      metadata,
      pendingWrites,
      ...(parent !== undefined ? { parentConfig: configFor(thread, namespace, parent) } : {}),
    }
  }

  async _header(config) {
    const thread = config?.configurable?.thread_id
    if (!thread) return undefined
    const namespace = config.configurable.checkpoint_ns ?? ""
    const id = getCheckpointId(config)
    if (id) {
      const row = await this.store.get(identity("checkpoint", thread, namespace, id))
      return isRecord(row, "checkpoint") ? row : undefined
    }
    for await (const row of this.store.ordered(
      { category: "checkpoint", scope: scopeFor(thread), stream: streamFor(thread, namespace) },
      { limit: 1 },
    )) {
      if (isRecord(row, "checkpoint")) return row
    }
    return undefined
  }

  async getTuple(config) {
    const row = await this._header(config)
    return row ? this._tuple(row) : undefined
  }

  async getDeltaChannelHistory(options) {
    const { config, channels } = options
    if (!channels.length) return {}
    const target = await this._header(config)
    const remaining = new Set(channels)
    const collected = new Map(channels.map((channel) => [channel, []]))
    const seeds = new Map()
    const visited = new Set()
    let cache = new Map()
    let cursor = target?.prev_ID
    while (cursor && remaining.size) {
      if (visited.has(cursor)) throw new Error("Cyclic checkpoint ancestry")
      visited.add(cursor)
      if (!cache.has(cursor)) {
        const row = await this.store.get(cursor)
        if (!isRecord(row, "checkpoint")) break
        // Prefetch bounded physical windows, but follow explicit parent links.
        // Forks and parents whose logical IDs sort later remain on the right path.
        const rows = await this.store.preceding(
          { category: "checkpoint", scope: row.scope, stream: row.stream },
          row.sequence,
        )
        const headers = await this._content().loadMany(rows.map((item) => item.content))
        const valueID = (item, channel, version) =>
          identity("value", item.query.thread, item.query.namespace, channel, String(version))
        const ids = rows.flatMap((item, i) =>
          Object.entries(headers[i].checkpoint.channel_versions)
            .filter(([channel]) => remaining.has(channel))
            .map(([channel, version]) => valueID(item, channel, version)),
        )
        const values = new Map((await this.store.getMany(ids)).map((value) => [value.ID, value]))
        cache = new Map(
          rows.map((item, i) => [
            item.ID,
            {
              row: item,
              checkpoint: headers[i].checkpoint,
              writes: [],
              values: new Map(
                [...remaining].map((channel) => [
                  channel,
                  values.get(
                    valueID(item, channel, headers[i].checkpoint.channel_versions[channel]),
                  ),
                ]),
              ),
            },
          ]),
        )
        for await (const write of this.store.list({
          category: "write",
          prev_ID: { in: rows.map((item) => item.ID) },
        })) {
          if (isRecord(write, "write") && remaining.has(write.query.channel))
            cache.get(write.prev_ID).writes.push(write)
        }
      }
      const entry = cache.get(cursor)
      // Preserve legacy pending-send migration semantics through the base walk.
      if (entry.checkpoint.v < 4) return super.getDeltaChannelHistory(options)
      entry.writes.sort(compareWrites)
      for (let i = entry.writes.length - 1; i >= 0; i--) {
        const write = entry.writes[i]
        if (remaining.has(write.query.channel)) collected.get(write.query.channel).push(write)
      }
      for (const channel of remaining) {
        const value = entry.values.get(channel)
        if (isRecord(value, "value") && !value.query.empty) {
          seeds.set(channel, value)
          remaining.delete(channel)
        }
      }
      cursor = entry.row.prev_ID
    }
    // Deserialize only the requested seeds and on-path writes, once, in batches.
    const records = new Map(
      [...seeds.values(), ...[...collected.values()].flat()].map((row) => [row.ID, row]),
    )
    const rows = [...records.values()]
    const loaded = await this._content().loadMany(rows.map((row) => row.content))
    const values = new Map(rows.map((row, i) => [row.ID, loaded[i]]))
    return Object.fromEntries(
      channels.map((channel) => [
        channel,
        {
          writes: collected
            .get(channel)
            .slice()
            .reverse()
            .map((row) => [row.query.task, channel, values.get(row.ID)]),
          ...(seeds.has(channel) ? { seed: values.get(seeds.get(channel).ID) } : {}),
        },
      ]),
    )
  }

  async *list(config, options = {}) {
    const {
      thread_id: thread,
      checkpoint_ns: namespace,
      checkpoint_id: id,
    } = config?.configurable ?? {}
    const before = options.before?.configurable?.checkpoint_id
    if (options.limit !== undefined && options.limit <= 0) return
    const where = {
      category: "checkpoint",
      ...(thread !== undefined ? { scope: scopeFor(thread) } : {}),
      ...(thread !== undefined && namespace !== undefined
        ? { stream: streamFor(thread, namespace) }
        : {}),
      ...(id !== undefined ? { sortKey: id } : {}),
    }
    let yielded = 0
    for await (const row of this.store.ordered(where, {
      before,
      ...(!options.filter && !(namespace !== undefined && thread === undefined)
        ? { limit: options.limit }
        : {}),
    })) {
      if (!isRecord(row, "checkpoint")) continue
      if (namespace !== undefined && row.query.namespace !== namespace) continue
      const loaded = await this._load(row.content)
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([key, value]) =>
            Object.hasOwn(loaded.metadata ?? {}, key) &&
            isDeepStrictEqual(loaded.metadata[key], value),
        )
      )
        continue
      yield await this._tuple(row, loaded)
      if (++yielded === options.limit) return
    }
  }

  async latestNamespace(thread) {
    if (!thread) return undefined
    for await (const row of this.store.ordered(
      { category: "checkpoint", scope: scopeFor(thread) },
      { limit: 1 },
    )) {
      return row.query.namespace
    }
    return undefined
  }

  async put(config, checkpoint, metadata, newVersions = checkpoint.channel_versions) {
    const thread = config?.configurable?.thread_id
    if (!thread) throw new Error('Missing required "thread_id" in config.configurable')
    const namespace = config.configurable.checkpoint_ns ?? ""
    const parent = config.configurable.checkpoint_id
    const prepared = copyCheckpoint(checkpoint)
    delete prepared.channel_values
    const plan = new Map()
    const shared = this._content(thread)
    const content = await shared.dump({ checkpoint: prepared, metadata }, plan)
    const values = await Promise.all(
      Object.entries(newVersions ?? {}).map(async ([channel, version]) => {
        const empty = !Object.hasOwn(checkpoint.channel_values ?? {}, channel)
        return this._message(
          identity("value", thread, namespace, channel, String(version)),
          { kind: "value", thread, namespace, channel, version, empty },
          empty ? null : await shared.dump(checkpoint.channel_values[channel], plan),
        )
      }),
    )
    const header = this._message(
      identity("checkpoint", thread, namespace, checkpoint.id),
      {
        kind: "checkpoint",
        thread,
        namespace,
        id: checkpoint.id,
        ...(parent !== undefined ? { parent } : {}),
      },
      content,
      parent === undefined ? null : identity("checkpoint", thread, namespace, parent),
    )
    await this.store.mutate(thread, async (store) => {
      const existing = new Set(
        (
          await store.getMany(
            values.map((value) => value.ID),
            ["ID"],
          )
        ).map((row) => row.ID),
      )
      const fresh = values.filter((value) => !existing.has(value.ID))
      await shared.persist(plan, [content, ...fresh.map((value) => value.content)], store)
      await store.putMany(fresh, { overwrite: false, knownNew: true })
      await store.put(header)
    })
    return configFor(thread, namespace, checkpoint.id)
  }

  async putWrites(config, writes, taskId, taskPath = "") {
    const {
      thread_id: thread,
      checkpoint_ns: namespace = "",
      checkpoint_id: id,
    } = config?.configurable ?? {}
    if (!thread || !id)
      throw new Error('Missing required "thread_id" or "checkpoint_id" in config.configurable')
    const plan = new Map()
    const shared = this._content(thread)
    const rows = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const idx = Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel] : index
        return this._message(
          identity("write", thread, namespace, id, taskId, idx),
          {
            kind: "write",
            thread,
            namespace,
            id,
            task: taskId,
            path: taskPath,
            index: idx,
            channel,
          },
          await shared.dump(value, plan),
          identity("checkpoint", thread, namespace, id),
        )
      }),
    )
    if (!rows.length) return
    await this.store.mutate(thread, async (store) => {
      const existing = new Set(
        (
          await store.getMany(
            rows.map((row) => row.ID),
            ["ID"],
          )
        ).map((row) => row.ID),
      )
      const accepted = rows.filter((row) => row.query.index < 0 || !existing.has(row.ID))
      await shared.persist(
        plan,
        accepted.map((row) => row.content),
        store,
      )
      await store.putMany(
        accepted.filter((row) => row.query.index >= 0),
        { overwrite: false, knownNew: true },
      )
      await store.putMany(accepted.filter((row) => row.query.index < 0))
    })
  }

  // Channel values are immutable per version. Distinct branches must mint
  // distinct versions even when they advance from the same parent.
  getNextVersion(current) {
    return Math.floor(super.getNextVersion(current)) + Math.random()
  }

  async deleteThread(threadId) {
    await this.store.deleteSession(threadId, { scope: scopeFor(threadId) })
  }
}
