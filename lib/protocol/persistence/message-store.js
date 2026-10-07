import { createHash } from "node:crypto"
import cds from "@sap/cds"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"

const PRIVATE_BLOCK_TYPES = new Set(["reasoning", "thinking"])

/**
 * Canonical persistence contract:
 * - one row per durable conversation message, keyed by its native message ID
 * - `session` is the protocol-neutral conversation ID
 * - `role`, `type`, and `content` are framework-neutral
 * - `query` carries structured message data such as tool calls, HITL decisions, or artifacts
 *
 * Runtime adapters reconstruct their own message objects from these fields. They must
 * not persist framework snapshots or duplicate content under `query`.
 */

function publicContent(content) {
  if (!Array.isArray(content)) return content
  return content.filter((block) => !PRIVATE_BLOCK_TYPES.has(block?.type))
}

function stableMessageId(session, sequence, message) {
  if (message.id) return message.id
  const digest = createHash("sha256")
    .update(session)
    .update("\0")
    .update(String(sequence))
    .update("\0")
    .update(JSON.stringify({ role: message.type, content: message.content }))
    .digest("hex")
    .slice(0, 24)
  return `message-${digest}`
}

function messageType(message) {
  if (message.type === "tool") return "tool_result"
  if (message.type === "ai" && message.tool_calls?.length) return "tool_call"
  return "text"
}

function langChainMessageEntries(session, messages, agentService, taskId) {
  const taskStart = messages.findIndex(({ id }) => id === taskId)
  const currentMessages = taskStart >= 0 ? messages.slice(taskStart) : messages
  return currentMessages.map((message, offset) => {
    const sequence = (taskStart >= 0 ? taskStart : 0) + offset
    const type = message._getType?.() ?? message.type
    return {
      ID: stableMessageId(session, sequence, { ...message, type }),
      session,
      sequence,
      ...(message.id !== taskId && taskId && { prev_ID: taskId }),
      agentService,
      role: type === "human" ? "user" : type === "ai" ? "assistant" : type,
      type: messageType({ ...message, type }),
      content: JSON.stringify(publicContent(message.content) ?? ""),
      query:
        type === "ai" && message.tool_calls?.length
          ? { toolCalls: message.tool_calls }
          : type === "tool"
            ? { toolCallId: message.tool_call_id, tool: message.name }
            : undefined,
    }
  })
}

export async function persistLangChainMessages({ session, messages, agentService, taskId }) {
  if (!session || !Array.isArray(messages)) return null

  const { Messages } = cds.entities("cap.agent")
  const entries = langChainMessageEntries(session, messages, agentService, taskId)
  if (entries.length) await UPSERT.into(Messages).entries(entries)

  return entries.length ? entries.length - 1 : null
}

export async function loadLangChainMessages(session, agentService) {
  if (!session) return []
  const { Messages } = cds.entities("cap.agent")
  const rows = await cds.ql.SELECT`from ${Messages} { ID, role, type, content, query }
    where session = ${session} and agentService = ${agentService} and createdBy = $user.id
    order by sequence`

  return rows
    .map((row) => {
      if (!["user", "assistant", "system", "tool"].includes(row.role)) return undefined
      const content = JSON.parse(row.content ?? '""')
      if (row.role === "user") return new HumanMessage({ id: row.ID, content })
      if (row.role === "system") return new SystemMessage({ id: row.ID, content })
      if (row.role === "tool") {
        return new ToolMessage({
          id: row.ID,
          content,
          tool_call_id: row.query?.toolCallId,
          name: row.query?.tool,
        })
      }
      return new AIMessage({
        id: row.ID,
        content,
        ...(row.query?.toolCalls && { tool_calls: row.query.toolCalls }),
      })
    })
    .filter(Boolean)
}

export async function ensureTaskAnchor({ taskId, contextId, message, agentService }) {
  const { Messages } = cds.entities("cap.agent")
  const latest = await cds.ql.SELECT.one`from ${Messages} { max(sequence) as sequence }
    where session = ${contextId} and createdBy = $user.id`
  await INSERT.into(Messages).entries({
    ID: taskId,
    session: contextId,
    sequence: Number(latest?.sequence ?? -1) + 1,
    role: "user",
    type: "text",
    content: JSON.stringify(message?.parts ?? []),
    query: { protocol: message },
    agentService,
  })
}

export async function appendMessage({
  ID = cds.utils.uuid(),
  session,
  prev_ID,
  role,
  type,
  content,
  query,
  agentService,
  requirePrev = false,
}) {
  if (!cds.db) return undefined
  const { Messages } = cds.entities("cap.agent")
  if (requirePrev && prev_ID) {
    const parent = await cds.ql.SELECT.one`from ${Messages} { ID }
      where ID = ${prev_ID} and createdBy = $user.id`
    if (!parent) return undefined
  }
  const latest = await cds.ql.SELECT.one`from ${Messages} { max(sequence) as sequence }
    where session = ${session} and createdBy = $user.id`
  await INSERT.into(Messages).entries({
    ID,
    session,
    sequence: Number(latest?.sequence ?? -1) + 1,
    prev_ID,
    role,
    type,
    content: typeof content === "string" ? content : JSON.stringify(content ?? null),
    query,
    agentService,
  })
  return ID
}

export async function loadLatestHitlRequest(session) {
  const { Messages } = cds.entities("cap.agent")
  const row = await cds.ql.SELECT.one`from ${Messages} { query }
    where session = ${session} and role = 'hitl' and type = 'request' and createdBy = $user.id
    order by sequence desc`
  return row?.query?.status
}
