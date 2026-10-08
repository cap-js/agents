import cds from "@sap/cds"

const LOG = cds.log("agents")
const DURABLE_STATES = new Set([
  "input-required",
  "auth-required",
  "canceled",
  "failed",
  "rejected",
])

function partContent(part) {
  return part.kind === "data" ? JSON.stringify(part.data) : (part.text ?? "")
}

function a2aMessage(rows, taskId, contextId) {
  const [first] = rows
  return {
    kind: "message",
    messageId: first.ID,
    role: first.role === "user" ? "user" : "agent",
    parts: rows.map((row, index) => {
      if (index > 0) {
        try {
          return { kind: "data", data: JSON.parse(row.content) }
        } catch {
          // A non-JSON continuation is another text part.
        }
      }
      return { kind: "text", text: row.content ?? "" }
    }),
    taskId,
    contextId,
  }
}

function groupMessages(rows, taskId, contextId) {
  const groups = []
  for (const row of rows) {
    const current = groups.at(-1)
    if (current && current[0].role === row.role && current[0].type === row.type) current.push(row)
    else groups.push([row])
  }
  return groups.map((group) => a2aMessage(group, taskId, contextId))
}

function deriveStatus(rows, history, taskId, contextId) {
  const terminal = rows.findLast(
    ({ role, type }) =>
      role === "ai" && ["auth-required", "canceled", "failed", "rejected"].includes(type),
  )
  if (terminal) {
    const terminalRows = rows.filter(
      ({ role, type, sequence }) =>
        role === terminal.role && type === terminal.type && sequence >= terminal.sequence,
    )
    return {
      state: terminal.type,
      message: a2aMessage(terminalRows, taskId, contextId),
      timestamp: terminal.createdAt,
    }
  }

  const latestHitlIndex = rows.findLastIndex(
    ({ role, type }) => role === "ai" && type === "request",
  )
  const latestHitlRequest = latestHitlIndex >= 0 ? rows[latestHitlIndex] : undefined
  const response = history.findLast(({ role }) => role === "agent")
  const responseRow = response && rows.find(({ ID }) => ID === response.messageId)
  if (latestHitlRequest && (!responseRow || latestHitlRequest.sequence > responseRow.sequence)) {
    return {
      state: "input-required",
      message: a2aMessage(
        rows.slice(latestHitlIndex).filter(({ role, type }) => role === "ai" && type === "request"),
        taskId,
        contextId,
      ),
      timestamp: latestHitlRequest.createdAt,
    }
  }
  return response ? { state: "completed", message: response } : { state: "submitted" }
}

/** A2A TaskStore projection over the framework-neutral Messages ledger. */
export class CdsTaskStore {
  async save(task) {
    const state = task.status?.state
    if (!DURABLE_STATES.has(state)) return

    const message = task.status?.message
    const { Messages } = cds.entities("cap.agent")
    const existing = await cds.ql.SELECT`from ${Messages} { ID, sequence }
      where session = ${task.contextId} and createdBy = $user.id`
    const sequences = new Map(existing.map(({ ID, sequence }) => [ID, Number(sequence)]))
    let sequence = existing.reduce((max, row) => Math.max(max, Number(row.sequence)), -1) + 1
    const entries = (task.history ?? [])
      .filter(({ messageId, role }) => role === "user" && messageId !== task.id)
      .flatMap((historyMessage) =>
        (historyMessage.parts ?? []).map((part, index) => {
          const ID = index === 0 ? historyMessage.messageId : cds.utils.uuid()
          return {
            ID,
            session: task.contextId,
            sequence: sequences.get(ID) ?? sequence++,
            role: "user",
            type: "decision",
            content: partContent(part),
            agentService: task.agentService ?? cds.context?.["agent.service"],
          }
        }),
      )
    entries.push(
      ...(message?.parts?.length ? message.parts : [{ kind: "text", text: "" }]).map(
        (part, index) => {
          const ID = index === 0 ? (message?.messageId ?? cds.utils.uuid()) : cds.utils.uuid()
          return {
            ID,
            session: task.contextId,
            sequence: sequences.get(ID) ?? sequence++,
            role: "ai",
            type: state === "input-required" ? "request" : state,
            content: partContent(part),
            agentService: task.agentService ?? cds.context?.["agent.service"],
          }
        },
      ),
    )
    await UPSERT.into(Messages).entries(entries)
  }

  async load(taskId) {
    const { Messages } = cds.entities("cap.agent")
    const sessionRows = await cds.ql.SELECT`from ${Messages} {
      ID, session, sequence, role, type, content, query, createdAt
      } where session in (
        select session from ${Messages}
          where ID = ${taskId} and role = 'user' and type = 'text' and createdBy = $user.id
      ) and createdBy = $user.id
      order by sequence`
    if (!sessionRows.length) {
      LOG._trace && LOG.debug("Task not found", { taskId })
      return undefined
    }

    const anchorIndex = sessionRows.findIndex(({ ID }) => ID === taskId)
    const anchor = sessionRows[anchorIndex]
    const nextTaskOffset = sessionRows
      .slice(anchorIndex + 1)
      .findIndex(({ role, type }) => role === "user" && type === "text")
    const end = nextTaskOffset < 0 ? sessionRows.length : anchorIndex + 1 + nextTaskOffset
    const historyRows = sessionRows.slice(0, end)
    const taskRows = sessionRows.slice(anchorIndex, end)
    const history = groupMessages(
      historyRows.filter(({ role, type }) => type === "text" && ["user", "ai"].includes(role)),
      taskId,
      anchor.session,
    )
    const artifacts = []
    const status = deriveStatus(taskRows, history, taskId, anchor.session)

    LOG._trace && LOG.debug("Task projection loaded", { taskId, state: status.state })
    return {
      kind: "task",
      id: taskId,
      contextId: anchor.session,
      status,
      history,
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
