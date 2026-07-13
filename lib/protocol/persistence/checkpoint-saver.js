/* eslint-disable no-await-in-loop */
import cds from "@sap/cds"
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
} from "@langchain/langgraph-checkpoint"

const LOG = cds.log("agent")

const toUtf8String = (bytes) => Buffer.from(bytes).toString("utf-8")

const CHECKPOINTS = "cap.agent.Checkpoints"
const WRITES = "cap.agent.CheckpointWrites"

const resolveUserId = () => {
  const id = cds.context?.user?.id
  if (!id)
    LOG.warn("cds.context missing or has no user — checkpoint query falls back to 'anonymous'")
  return id ?? "anonymous"
}

/**
 * CDS entity-backed LangGraph checkpoint saver.
 *
 * Persists graph state to cap.agent.Checkpoints and cap.agent.CheckpointWrites,
 * enabling multi-turn conversations.
 *
 * Implements BaseCheckpointSaver from @langchain/langgraph-checkpoint.
 * Uses inherited JsonPlusSerializer (this.serde) to handle LangChain-specific
 * types (messages, tool calls, etc.).
 */
export class CdsCheckpointSaver extends BaseCheckpointSaver {
  constructor(serde) {
    super(serde)
  }

  /**
   * Load a checkpoint for a thread.
   * If checkpoint_id in config -> load that exact checkpoint.
   * Otherwise -> load latest (checkpoint_id is UUID6, time-ordered, so desc = latest).
   * Also loads associated CheckpointWrites (LangGraph expects them in the tuple).
   */
  async getTuple(config) {
    const thread_id = config.configurable?.thread_id
    if (!thread_id) return undefined
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
    const checkpoint_id = getCheckpointId(config)

    let row
    if (checkpoint_id) {
      row = await SELECT.one
        .from(CHECKPOINTS)
        .where({ thread_id, checkpoint_ns, checkpoint_id, createdBy: resolveUserId() })
    } else {
      row = await SELECT.one
        .from(CHECKPOINTS)
        .where({ thread_id, checkpoint_ns, createdBy: resolveUserId() })
        .orderBy("checkpoint_id desc")
    }

    if (!row) return undefined

    const actualCheckpointId = row.checkpoint_id

    const persistAll = cds.env.agents?.persistAllCheckpointWrites === true
    const writesFilter = { thread_id, checkpoint_ns, checkpoint_id: actualCheckpointId }
    if (!persistAll) writesFilter.idx = { "<": 0 }
    const writeRows = await SELECT.from(WRITES).where(writesFilter)

    // Deserialize via inherited JsonPlusSerializer (handles LangChain message types etc.)
    const checkpoint = await this.serde.loadsTyped("json", row.checkpoint)
    const metadata = await this.serde.loadsTyped("json", row.metadata)
    const pendingWrites = await Promise.all(
      writeRows.map(async (w) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped("json", w.value),
      ]),
    )

    const tuple = {
      config: {
        configurable: { thread_id, checkpoint_ns, checkpoint_id: actualCheckpointId },
      },
      checkpoint,
      metadata,
      pendingWrites,
    }

    // Link to parent checkpoint for time-travel / history chain
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id,
          checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      }
    }

    LOG.debug("Checkpoint loaded", { thread_id, checkpoint_id: actualCheckpointId })
    return tuple
  }

  /**
   * Save a new checkpoint after a graph step completes.
   * config.configurable.checkpoint_id = the PARENT checkpoint (what was loaded before this step).
   * checkpoint.id = the NEW checkpoint being stored.
   */
  async put(config, checkpoint, metadata) {
    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
    const parent_checkpoint_id = config.configurable?.checkpoint_id

    if (!thread_id) {
      throw new Error('Missing required "thread_id" in config.configurable')
    }

    const prepared = copyCheckpoint(checkpoint)
    const [, serializedCheckpoint] = await this.serde.dumpsTyped(prepared)
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata)

    await UPSERT.into(CHECKPOINTS).entries({
      thread_id,
      checkpoint_ns,
      checkpoint_id: checkpoint.id,
      parent_checkpoint_id,
      checkpoint: toUtf8String(serializedCheckpoint),
      metadata: toUtf8String(serializedMetadata),
    })

    LOG.debug("Checkpoint saved", { thread_id, checkpoint_id: checkpoint.id })

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    }
  }

  /**
   * Save intermediate node outputs during a graph step.
   * Called by LangGraph after each node finishes, before the next checkpoint is created.
   * Special channels (__interrupt__, __error__) get negative indices via WRITES_IDX_MAP.
   *
   * By default only special (negative-index) writes are persisted to reduce DB load.
   * Regular node outputs are already captured in the checkpoint blob via put().
   * Enable cds.env.agents.persistAllCheckpointWrites for custom graphs with parallel branches.
   */
  async putWrites(config, writes, taskId) {
    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
    const checkpoint_id = config.configurable?.checkpoint_id

    if (!thread_id || !checkpoint_id) {
      throw new Error('Missing required "thread_id" or "checkpoint_id" in config.configurable')
    }

    const persistAll = cds.env.agents?.persistAllCheckpointWrites === true
    const entries = []

    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i]
      const idx = WRITES_IDX_MAP[channel] ?? i

      // Skip positive-index (regular node output) writes unless full persistence enabled
      if (!persistAll && idx >= 0) continue

      // Dedup: skip positive-index writes that already exist
      if (idx >= 0) {
        const existing = await SELECT.one
          .from(WRITES)
          .columns("task_id")
          .where({ thread_id, checkpoint_ns, checkpoint_id, task_id: taskId, idx })
        if (existing) continue
      }

      const [, serializedValue] = await this.serde.dumpsTyped(value)

      entries.push({
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id: taskId,
        idx,
        channel,
        value: toUtf8String(serializedValue),
      })
    }

    if (entries.length > 0) {
      await UPSERT.into(WRITES).entries(entries)
    }
  }

  /**
   * Stream checkpoints for a thread, newest first.
   */
  async *list(config, options) {
    const { thread_id, checkpoint_ns = "" } = config?.configurable ?? {}
    if (!thread_id) return

    const userLimit = options?.limit
    const BATCH_SIZE = 100
    let cursorBefore = options?.before?.configurable?.checkpoint_id
    let yielded = 0

    while (true) {
      const remaining = userLimit ? userLimit - yielded : Infinity
      if (remaining <= 0) return
      const batchSize = Math.min(BATCH_SIZE, remaining)

      const rows = await SELECT.from(CHECKPOINTS)
        .where({
          thread_id,
          checkpoint_ns,
          createdBy: resolveUserId(),
          ...(cursorBefore ? { checkpoint_id: { "<": cursorBefore } } : {}),
        })
        .orderBy("checkpoint_id desc")
        .limit(batchSize)

      if (rows.length === 0) return

      for (const row of rows) {
        const [checkpoint, metadata] = await Promise.all([
          this.serde.loadsTyped("json", row.checkpoint),
          this.serde.loadsTyped("json", row.metadata),
        ])
        yield {
          config: {
            configurable: { thread_id, checkpoint_ns, checkpoint_id: row.checkpoint_id },
          },
          checkpoint,
          metadata,
          parentConfig: row.parent_checkpoint_id
            ? {
                configurable: { thread_id, checkpoint_ns, checkpoint_id: row.parent_checkpoint_id },
              }
            : undefined,
        }
        yielded++
      }

      // Short batch -> no more rows beyond it.
      if (rows.length < batchSize) return

      // Advance cursor: oldest row of this batch (rows are checkpoint_id desc).
      cursorBefore = rows[rows.length - 1].checkpoint_id
    }
  }

  async deleteThread(threadId) {
    const checkpointIds = await SELECT.from(CHECKPOINTS)
      .columns("checkpoint_id", "checkpoint_ns")
      .where({ thread_id: threadId, createdBy: cds.context.user.id })

    if (checkpointIds.length > 0) {
      const ids = checkpointIds.map(({ checkpoint_id }) => checkpoint_id)
      await DELETE.from(WRITES).where({ thread_id: threadId, checkpoint_id: { in: ids } })
    }

    await DELETE.from(CHECKPOINTS).where({ thread_id: threadId, createdBy: cds.context.user.id })
  }
}
