import cds from "@sap/cds"
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { loadLangChainMessages, persistLangChainMessages } from "./message-store.js"

const LOG = cds.log("agents")

/**
 * LangGraph adapter over the framework-neutral Messages ledger.
 * Checkpoints are synthesized from messages; LangGraph metadata and snapshots are not persisted.
 */
export class CdsCheckpointSaver extends BaseCheckpointSaver {
  async latestNamespace(threadId) {
    if (!threadId) return undefined
    const [agentService, session] = threadId.split(":")
    const { Messages } = cds.entities("cap.agent")
    const row = await cds.ql.SELECT.one`from ${Messages} { ID }
      where session = ${session} and agentService = ${agentService} and createdBy = $user.id`
    return row ? "" : undefined
  }

  async getTuple(config) {
    const threadId = config.configurable?.thread_id
    if (!threadId) return undefined
    const [agentService, session] = threadId.split(":")

    const messages = await loadLangChainMessages(session, agentService)
    if (!messages.length) return undefined

    const checkpoint = emptyCheckpoint()
    checkpoint.id =  messages.at(-1).id
    checkpoint.channel_values = { messages }

    return {
      config: {
        configurable: {
          thread_id: `${agentService}:${session}`,
          checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
          checkpoint_id: checkpoint.id,
        },
      },
      checkpoint,
      metadata: {},
      pendingWrites: [],
    }
  }

  async put(config, checkpoint) {
    const threadId = config.configurable?.thread_id
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? ""
    if (!threadId) throw new Error('Missing required "thread_id" in config.configurable')
    const [agentService, session] = threadId.split(":")

    const messages = checkpoint.channel_values?.messages ?? []
    await persistLangChainMessages({
      session,
      messages,
      agentService,
      taskId: config.configurable?._taskId,
    })

    LOG._trace && LOG.debug("Conversation messages saved", { threadId })
    return {
      configurable: {
        thread_id: `${agentService}:${session}`,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    }
  }

  async putWrites(config) {
    const threadId = config.configurable?.thread_id
    if (!threadId) throw new Error('Missing required "thread_id" in config.configurable')
  }

  async *list(config, options) {
    if (options?.limit === 0 || options?.before) return
    const tuple = await this.getTuple(config)
    if (tuple) yield tuple
  }

  async deleteThread(threadId) {
    const [agentService, session] = threadId.split(":")
    const { Messages } = cds.entities("cap.agent")
    await DELETE.from(Messages)
      .where`session = ${session} and agentService = ${agentService} and createdBy = $user.id`
  }
}
