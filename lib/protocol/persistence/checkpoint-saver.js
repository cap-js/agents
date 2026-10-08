import cds from "@sap/cds"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph-checkpoint"

const LOG = cds.log("agents")
const PRIVATE_BLOCK_TYPES = new Set(["reasoning", "thinking"])

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
    if (!threadId) throw new Error('Missing required "thread_id" in config.configurable')
    const [agentService, session] = threadId.split(":")

    const { Messages } = cds.entities("cap.agent")
    const latest = await cds.ql.SELECT.one`from ${Messages} { ID, sequence }
      where session = ${session} and agentService = ${agentService} and createdBy = $user.id
      order by sequence desc`

    let sequence = latest?.sequence ?? -1
    const entries = []
    const messages = checkpoint.channel_values?.messages ?? []
    for (const message of messages) {
      const role = message._getType?.() ?? message.type
      const ID =
        role === "tool" && message.tool_call_id
          ? message.tool_call_id
          : (message.id ??= cds.utils.uuid())
      message.id = ID

      if (ID === latest?.ID) {
        entries.length = 0
        sequence = latest.sequence
        continue
      }

      entries.push({
        ID,
        session,
        sequence: ++sequence,
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
      })
    }

    if (entries.length) await UPSERT.into(Messages).entries(entries)

    LOG._trace && LOG.debug("Conversation messages saved", { threadId })
    return {
      configurable: {
        thread_id: `${agentService}:${session}`,
        checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
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

function textContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block) => !PRIVATE_BLOCK_TYPES.has(block?.type))
    .map((block) => block?.text ?? block?.content?.value ?? "")
    .join("")
}

function messageType(message) {
  if (message.additional_kwargs?.["sap.cds.agents.type"] === "decision") return "decision"
  if (message.type === "tool") return "tool_result"
  if (message.type === "ai" && message.tool_calls?.length) return "tool_call"
  return "text"
}
