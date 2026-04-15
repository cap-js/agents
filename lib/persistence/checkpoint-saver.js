/* eslint-disable no-await-in-loop */
const cds = require("@sap/cds")

const LOG = cds.log("a2a")

const toUtf8String = (bytes) => Buffer.from(bytes).toString("utf-8")

const CHECKPOINTS = "cap.a2a.Checkpoints"
const WRITES = "cap.a2a.CheckpointWrites"

// Lazy-load ESM-only @langchain/langgraph-checkpoint module
let _BaseClass = null
let _utils = null

async function getBase() {
  if (_BaseClass) return { BaseCheckpointSaver: _BaseClass, ..._utils }
  const mod = await import("@langchain/langgraph-checkpoint")
  _BaseClass = mod.BaseCheckpointSaver
  _utils = {
    WRITES_IDX_MAP: mod.WRITES_IDX_MAP,
    copyCheckpoint: mod.copyCheckpoint,
    getCheckpointId: mod.getCheckpointId,
  }
  return { BaseCheckpointSaver: _BaseClass, ..._utils }
}

/**
 * Creates a CDS entity-backed LangGraph checkpoint saver.
 *
 * Persists graph state to cap.a2a.Checkpoints and cap.a2a.CheckpointWrites,
 * enabling multi-turn conversations
 *
 * Implements BaseCheckpointSaver from @langchain/langgraph-checkpoint.
 * Uses inherited JsonPlusSerializer (this.serde) to handle LangChain-specific
 * types (messages, tool calls, etc.).
 */
async function createCheckpointSaver() {
  const { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } = await getBase()

  class CdsCheckpointSaver extends BaseCheckpointSaver {
    constructor(serde) {
      super(serde)
    }

    /**
     * Load a checkpoint for a thread.
     * If checkpoint_id in config → load that exact checkpoint.
     * Otherwise → load latest (checkpoint_id is UUID6, time-ordered, so desc = latest).
     * Also loads associated CheckpointWrites (LangGraph expects them in the tuple).
     */
    async getTuple(config) {
      const thread_id = config.configurable?.thread_id
      if (!thread_id) return undefined
      const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
      const checkpoint_id = getCheckpointId(config)

      let row
      if (checkpoint_id) {
        row = await SELECT.one.from(CHECKPOINTS).where({ thread_id, checkpoint_ns, checkpoint_id })
      } else {
        row = await SELECT.one
          .from(CHECKPOINTS)
          .where({ thread_id, checkpoint_ns })
          .orderBy("checkpoint_id desc")
      }

      if (!row) return undefined

      const actualCheckpointId = row.checkpoint_id

      const writeRows = await SELECT.from(WRITES).where({
        thread_id,
        checkpoint_ns,
        checkpoint_id: actualCheckpointId,
      })

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
     * Positive-index writes are deduplicated (skip if already stored).
     */
    async putWrites(config, writes, taskId) {
      const thread_id = config.configurable?.thread_id
      const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
      const checkpoint_id = config.configurable?.checkpoint_id

      if (!thread_id || !checkpoint_id) {
        throw new Error('Missing required "thread_id" or "checkpoint_id" in config.configurable')
      }

      const entries = []

      for (let i = 0; i < writes.length; i++) {
        const [channel, value] = writes[i]
        const idx = WRITES_IDX_MAP[channel] ?? i

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

    // eslint-disable-next-line require-yield
    async *list() {
      LOG.debug("list() not yet implemented")
    }

    async deleteThread(threadId) {
      await DELETE.from(WRITES).where({ thread_id: threadId })
      await DELETE.from(CHECKPOINTS).where({ thread_id: threadId })
    }
  }

  return new CdsCheckpointSaver()
}

module.exports = { createCheckpointSaver }
