import cds from "@sap/cds"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph-checkpoint"

const LOG = cds.log("agents")
const PRIVATE_BLOCK_TYPES = new Set(["reasoning", "thinking"])

function textContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block) => !PRIVATE_BLOCK_TYPES.has(block?.type))
    .map((block) => block?.text ?? block?.content?.value ?? "")
    .join("")
}

function messageType(message) {
  if (message.type === "tool") return "tool_result"
  if (message.type === "ai" && message.tool_calls?.length) return "tool_call"
  return "text"
}

/**
 * LangGraph adapter over the framework-neutral Messages ledger.
 * Checkpoints are synthesized from messages; LangGraph metadata and snapshots are not persisted.
 */
export class CdsCheckpointSaver extends BaseCheckpointSaver {
  async getTuple(config) {
    const threadId = config.configurable?.thread_id
    if (!threadId) return undefined
    const [agentService, session] = threadId.split(":")

    const { Messages } = cds.entities("cap.agent")
    const rows = await cds.ql.SELECT`from ${Messages} {
      ID, role, type, content, query
      } where session = ${session} and agentService = ${agentService}
        and type in ('text', 'tool_call', 'tool_result') and createdBy = $user.id
      order by sequence`
    if (!rows.length) return undefined

    const messages = rows
      .map((row) => {
        switch (row.role) {
          case "user":
            return new HumanMessage({ id: row.ID, content: row.content ?? "" })
          case "system":
            return new SystemMessage({ id: row.ID, content: row.content ?? "" })
          case "tool":
            return new ToolMessage({
              id: row.ID,
              content: row.content ?? "",
              tool_call_id: row.ID,
              name: row.query?.tool,
            })
          case "ai":
            return new AIMessage({
              id: row.ID,
              content: row.content ?? "",
              ...(row.query?.toolCalls && { tool_calls: row.query.toolCalls }),
            })
          default:
            return undefined
        }
      })
      .filter(Boolean)

    const checkpoint = emptyCheckpoint()
    checkpoint.id = messages.at(-1).id
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
    for (const message of messages) {
      const role = message._getType?.() ?? message.type
      if (role === "tool" && message.tool_call_id) message.id = message.tool_call_id
      else message.id ??= cds.utils.uuid()
    }
    const { Messages } = cds.entities("cap.agent")
    const existing = await cds.ql.SELECT`from ${Messages} { ID, sequence }
      where session = ${session} and createdBy = $user.id`
    const sequences = new Map(existing.map(({ ID, sequence }) => [ID, Number(sequence)]))
    let sequence = existing.reduce((max, row) => Math.max(max, Number(row.sequence)), -1) + 1
    for (const message of messages) {
      if (!sequences.has(message.id)) sequences.set(message.id, sequence++)
    }
    const taskId = config.configurable?._taskId
    const taskStart = messages.findIndex(({ id }) => id === taskId)
    const currentMessages = taskStart >= 0 ? messages.slice(taskStart) : messages
    const entries = currentMessages.map((message) => {
      const role = message._getType?.() ?? message.type
      return {
        ID: message.id,
        session,
        sequence: sequences.get(message.id),
        agentService,
        role: role === "human" ? "user" : role,
        type: messageType({ ...message, type: role }),
        content: textContent(message.content),
        query:
          role === "ai" && message.tool_calls?.length
            ? { toolCalls: message.tool_calls }
            : role === "tool"
              ? { tool: message.name }
              : null,
      }
    })
    if (entries.length) await UPSERT.into(Messages).entries(entries)

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
