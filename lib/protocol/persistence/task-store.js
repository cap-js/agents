import cds from "@sap/cds"

const LOG = cds.log("agents")
const DURABLE_STATES = {
  "input-required": 1,
  "auth-required": 1,
  canceled: 1,
  failed: 1,
  rejected: 1,
}

/** A2A TaskStore projection over the framework-neutral Messages ledger. */
export class CdsTaskStore {
  async save(task) {
    const state = task.status?.state
    if (!(state in DURABLE_STATES)) return

    const message = task.status?.message
    const { Messages } = cds.entities("cap.agent")
    const latest = await cds.ql.SELECT.one`from ${Messages} { ID, sequence }
      where session = ${task.contextId} and createdBy = $user.id
      order by sequence desc`
    let sequence = latest?.sequence ?? -1
    const entries = (message?.parts?.length ? message.parts : [{ kind: "text", text: "" }]).map(
      (part, index) => ({
        ID: index === 0 ? (message?.messageId ?? cds.utils.uuid()) : cds.utils.uuid(),
        session: task.contextId,
        sequence: ++sequence,
        role: "ai",
        type: state === "input-required" ? "request" : state,
        content: partContent(part),
        agentService: task.agentService ?? cds.context?.["agent.service"],
      }),
    )
    await UPSERT.into(Messages).entries(entries)
  }

  async load(taskId) {
    const { Messages } = cds.entities("cap.agent")
    const session = cds.ql.SELECT.one`from ${Messages} { session }
      where ID = ${taskId} and role = 'user' and type = 'text' and createdBy = $user.id`

    const taskSequence = cds.ql.SELECT.one`from ${Messages} { sequence }
      where ID = ${taskId} and role = 'user' and type = 'text' and createdBy = $user.id`

    const nextTask = cds.ql.SELECT.one`from ${Messages} { sequence }
      where session in (${session}) and sequence > (${taskSequence})
        and role = 'user' and type = 'text' and createdBy = $user.id
      order by sequence`

    const sessionRows = await cds.ql.SELECT`from ${Messages} {
      ID, session, sequence, role, type, content, query, createdAt
      } where session in (${session}) and createdBy = $user.id
        and sequence < coalesce((${nextTask}), 9223372036854775807)
      order by sequence`

    if (!sessionRows.length) {
      LOG._trace && LOG.debug("Task not found", { taskId })
      return undefined
    }

    let anchor
    const history = []
    let terminal
    let hitl
    let response
    let group = []
    let groupIsTask

    for (const [index, row] of sessionRows.entries()) {
      if (!group.length) groupIsTask = Boolean(anchor)
      if (row.ID === taskId) {
        anchor = row
        groupIsTask = true
      }
      group.push(row)

      const next = sessionRows[index + 1]
      if (next?.role === row.role && next.type === row.type) continue

      const [first] = group
      const message = a2aMessage(group, taskId, first.session)
      if (first.type === "text" && (first.role === "user" || first.role === "ai")) {
        history.push(message)
        if (first.role === "ai") response = { sequence: first.sequence, message }
      }
      if (groupIsTask && first.role === "ai") {
        if (first.type in { "auth-required": 1, canceled: 1, failed: 1, rejected: 1 })
          terminal = {
            state: first.type,
            message,
            timestamp: first.createdAt,
          }
        else if (first.type === "request")
          hitl = {
            sequence: first.sequence,
            message,
            timestamp: first.createdAt,
          }
      }
      group = []
      groupIsTask = false
    }

    const artifacts = []
    const taskStatus = terminal
      ? terminal
      : hitl && (!response || hitl.sequence > response.sequence)
        ? {
            state: "input-required",
            message: hitl.message,
            timestamp: hitl.timestamp,
          }
        : response
          ? { state: "completed", message: response.message }
          : { state: "submitted" }

    LOG._trace && LOG.debug("Task projection loaded", { taskId, state: taskStatus.state })
    return {
      kind: "task",
      id: taskId,
      contextId: anchor.session,
      status: taskStatus,
      history,
      ...(taskStatus.message || artifacts.length
        ? {
            artifacts: [
              ...artifacts,
              ...(taskStatus.message
                ? [{ artifactId: "response", parts: taskStatus.message.parts }]
                : []),
            ],
          }
        : {}),
    }
  }
}

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
