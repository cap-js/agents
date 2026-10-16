import cds from "@sap/cds"
import { isDeepStrictEqual } from "node:util"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph-checkpoint"

const LOG = cds.log("agents")
const PRIVATE_BLOCK_TYPES = new Set(["reasoning", "thinking"])
const pendingInterrupt = Symbol("cap.agent.pendingInterrupt")

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
      order by createdAt, sequence`
    if (!rows.length) return undefined

    const messages = []
    let group
    const flushGroup = () => {
      if (!group) return
      const message = langChainMessageFromGroup(group)
      if (message) messages.push(message)
    }
    for (const row of rows) {
      const messageId = row.query?.messageId ?? row.ID
      if (
        group &&
        (group.role !== row.role || group.type !== row.type || group.messageId !== messageId)
      ) {
        flushGroup()
        group = undefined
      }
      group ??= {
        role: row.role,
        type: row.type,
        messageId,
        content: "",
        first: row,
        toolCalls: [],
      }
      group.content += row.content ?? ""
      if (row.query?.toolCall) group.toolCalls.push(row.query.toolCall)
    }
    flushGroup()

    const checkpoint = emptyCheckpoint()
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
    const entries = []
    const context = cds.context?.context ?? cds.context
    const interrupt = context?.[pendingInterrupt]
    const pendingRequests = [
      ...((Array.isArray(interrupt) ? interrupt[0] : interrupt)?.value?.actionRequests ?? []),
    ]
    let sequence = 0
    const messages = checkpoint.channel_values?.messages ?? []
    for (const message of messages) {
      const role = message._getType?.() ?? message.type
      const rowCount = role === "ai" && message.tool_calls?.length ? message.tool_calls.length : 1
      if (isUuid(message.id)) {
        sequence += rowCount
        continue
      }
      const messageId = (message.id ??= cds.utils.uuid())

      const base = {
        session,
        agentService,
        role: role === "human" ? "user" : role,
        type: messageType({ ...message, type: role }),
        content: textContent(message.content),
      }
      if (role === "ai" && message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          const requestIndex = pendingRequests.findIndex((request) => matchesRequest(call, request))
          entries.push({
            ...base,
            ID: cds.utils.uuid(),
            sequence: sequence++,
            query: {
              toolCall: call,
              messageId,
              ...(requestIndex >= 0 && { inputRequired: interrupt }),
            },
          })
          if (requestIndex >= 0) pendingRequests.splice(requestIndex, 1)
        }
      } else {
        entries.push({
          ...base,
          ID: cds.utils.uuid(),
          sequence: sequence++,
          query: {
            messageId,
            ...(role === "tool" && { tool: message.name, toolCallId: message.tool_call_id }),
          },
        })
      }
    }

    if (entries.length) await INSERT.into(Messages).entries(entries)
    if (context && interrupt) delete context[pendingInterrupt]

    LOG._trace && LOG.debug("Conversation messages saved", { threadId })
    return {
      configurable: {
        thread_id: `${agentService}:${session}`,
        checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
        checkpoint_id: checkpoint.id,
      },
    }
  }

  async putWrites(config, writes) {
    const threadId = config.configurable?.thread_id
    if (!threadId) throw new Error('Missing required "thread_id" in config.configurable')
    const interrupt = writes?.find(([channel]) => channel === "__interrupt__")?.[1]
    const requests = (Array.isArray(interrupt) ? interrupt[0] : interrupt)?.value?.actionRequests
    if (!requests?.length) return
    const context = cds.context?.context ?? cds.context
    if (context) context[pendingInterrupt] = interrupt
  }

  async putDecision(config, message) {
    const [agentService, session] = config.configurable.thread_id.split(":")
    const { Messages } = cds.entities("cap.agent")
    await INSERT.into(Messages).entries({
      ID: cds.utils.uuid(),
      session,
      sequence: 0,
      agentService,
      role: "user",
      type: "decision",
      content: textContent(message.content),
      query: { messageId: message.id },
    })
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

function langChainMessageFromGroup({ role, type, content, first, toolCalls }) {
  if (type === "tool_call") return new AIMessage({ id: first.ID, content, tool_calls: toolCalls })
  switch (role) {
    case "user":
      return new HumanMessage({ id: first.ID, content })
    case "system":
      return new SystemMessage({ id: first.ID, content })
    case "tool":
      return new ToolMessage({
        id: first.ID,
        content,
        tool_call_id: first.query?.toolCallId ?? first.ID,
        name: first.query?.tool,
      })
    case "ai":
      return new AIMessage({ id: first.ID, content })
    default:
      return undefined
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

const matchesRequest = (call, request) =>
  call &&
  (request.id === call.id ||
    (!request.id && request.name === call.name && isDeepStrictEqual(request.args, call.args)))

const isUuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
