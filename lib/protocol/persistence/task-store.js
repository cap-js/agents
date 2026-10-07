import { createHash } from "node:crypto"
import cds from "@sap/cds"

const LOG = cds.log("agents")
const MESSAGES = "cap.agent.Messages"
export const PERSIST_TASK = Symbol("persist-task")
const EXPLICIT_MESSAGE_STATES = new Set([
  "input-required",
  "auth-required",
  "canceled",
  "failed",
  "rejected",
])

function a2aMessage(row, taskId, contextId) {
  const protocol = row.query?.protocol
  if (protocol) return { ...protocol, taskId, contextId }
  if (row.type !== "text" || !["user", "assistant"].includes(row.role)) return undefined

  const value = JSON.parse(row.content ?? '""')
  const text =
    typeof value === "string"
      ? value
      : value
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("")
  return {
    kind: "message",
    messageId: row.ID,
    role: row.role === "user" ? "user" : "agent",
    parts: [{ kind: "text", text }],
    taskId,
    contextId,
  }
}

function artifactMessageId(taskId, artifactId) {
  const digest = createHash("sha256").update(taskId).update("\0").update(artifactId).digest("hex")
  return `artifact-${digest}`
}

async function nextSequence(session) {
  const row = await SELECT.one
    .from(MESSAGES)
    .columns("max(sequence) as sequence")
    .where({ session, createdBy: cds.context.user.id })
  return Number(row?.sequence ?? -1) + 1
}

function deriveStatus(rows, history) {
  const latestHitlRequest = rows.findLast(({ role, type }) => role === "hitl" && type === "request")

  const terminal = rows.findLast(
    ({ role, type }) =>
      role === "assistant" && ["auth-required", "canceled", "failed", "rejected"].includes(type),
  )
  if (terminal) return terminal.query?.status ?? { state: terminal.type }

  const response = history.findLast(({ role }) => role === "agent")
  const responseRow = response && rows.find(({ ID }) => ID === response.messageId)
  if (latestHitlRequest && (!responseRow || latestHitlRequest.sequence > responseRow.sequence)) {
    return latestHitlRequest.query?.status ?? { state: "input-required" }
  }
  return response ? { state: "completed", message: response } : { state: "submitted" }
}

/** A2A TaskStore projection over the framework-neutral Messages ledger. */
export class CdsTaskStore {
  async save(task) {
    const state = task.status?.state
    const marked = task[PERSIST_TASK] || task.status?.[PERSIST_TASK]
    const sdkCancellation = state === "canceled"
    if (!marked && !sdkCancellation) return
    delete task[PERSIST_TASK]
    if (task.status) delete task.status[PERSIST_TASK]

    if (EXPLICIT_MESSAGE_STATES.has(state)) {
      const statusMessage = task.status?.message
      await INSERT.into(MESSAGES).entries({
        ID: statusMessage?.messageId ?? `status-${task.id}`,
        session: task.contextId,
        sequence: await nextSequence(task.contextId),
        prev_ID: task.id,
        role: state === "input-required" ? "hitl" : "assistant",
        type: state === "input-required" ? "request" : state,
        content: JSON.stringify(statusMessage?.parts ?? []),
        query: { status: task.status, metadata: task.metadata },
        agentService: cds.context?.["agent.service"],
        createdBy: cds.context.user.id,
      })
    }

    const artifacts = (task.artifacts ?? []).filter(
      ({ artifactId }) => artifactId !== "response" && !artifactId?.startsWith("thinking-"),
    )
    if (artifacts.length) {
      const sequence = await nextSequence(task.contextId)
      await UPSERT.into(MESSAGES).entries(
        artifacts.map((artifact, index) => ({
          ID: artifactMessageId(task.id, artifact.artifactId),
          session: task.contextId,
          sequence: sequence + index,
          prev_ID: task.id,
          role: "assistant",
          type: artifact.parts?.[0]?.kind ?? "data",
          content: JSON.stringify(artifact.parts ?? []),
          query: { artifact },
          agentService: cds.context?.["agent.service"],
          createdBy: cds.context.user.id,
        })),
      )
    }

    LOG._trace && LOG.debug("Task projection saved", { taskId: task.id, state })
  }

  async load(taskId) {
    const anchor = await SELECT.one
      .from(MESSAGES)
      .columns("ID", "session", "sequence")
      .where({ ID: taskId, role: "user", prev_ID: null, createdBy: cds.context.user.id })
    if (!anchor) {
      LOG._trace && LOG.debug("Task not found", { taskId })
      return undefined
    }

    const nextTask = await SELECT.one
      .from(MESSAGES)
      .columns("sequence")
      .where({
        session: anchor.session,
        role: "user",
        prev_ID: null,
        sequence: { ">": anchor.sequence },
        createdBy: cds.context.user.id,
      })
      .orderBy("sequence")
    const rows = await SELECT.from(MESSAGES)
      .columns("ID", "sequence", "role", "type", "content", "query")
      .where({
        session: anchor.session,
        sequence: {
          ">=": anchor.sequence,
          ...(nextTask && { "<": nextTask.sequence }),
        },
        createdBy: cds.context.user.id,
      })
      .orderBy("sequence")
    const history = rows.map((row) => a2aMessage(row, taskId, anchor.session)).filter(Boolean)
    const artifacts = rows.map(({ query }) => query?.artifact).filter(Boolean)
    const status = deriveStatus(rows, history)
    const metadata = rows.findLast(({ query }) => query?.metadata)?.query.metadata

    LOG._trace && LOG.debug("Task projection loaded", { taskId, state: status.state })
    return {
      kind: "task",
      id: taskId,
      contextId: anchor.session,
      status,
      history,
      ...(metadata && { metadata }),
      ...(status.message || artifacts.length
        ? {
            artifacts: [
              ...artifacts,
              ...(status.message ? [{ artifactId: "response", parts: status.message.parts }] : []),
            ],
          }
        : {}),
    }
  }
}
