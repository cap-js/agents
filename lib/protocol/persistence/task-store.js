import cds from "@sap/cds"

const LOG = cds.log("agents")

/** A2A TaskStore projection over the framework-neutral Messages ledger. */
export class CdsTaskStore {
  async save() {}

  async load(taskId) {
    const { Messages } = cds.entities("cap.agent")
    const session = cds.ql.SELECT.one`from ${Messages} { session }
      where ID = ${taskId} and role = 'user' and type = 'text' and createdBy = $user.id`

    let sessionRows = await cds.ql.SELECT`from ${Messages} {
      ID, session, sequence, role, type, content, query, createdAt
      } where session in (${session}) and createdBy = $user.id
      order by createdAt, sequence`

    if (!sessionRows.length) {
      LOG._trace && LOG.debug("Task not found", { taskId })
      return undefined
    }
    const anchorIndex = sessionRows.findIndex(({ ID }) => ID === taskId)
    const nextTaskIndex = sessionRows.findIndex(
      (row, index) => index > anchorIndex && row.role === "user" && row.type === "text",
    )
    if (nextTaskIndex >= 0) sessionRows = sessionRows.slice(0, nextTaskIndex)

    let anchor
    const history = []
    let terminal
    let response
    let inputRequired,
      pendingHitl = new Set()
    const decisions = []
    let group = []
    let groupIsTask

    for (const [index, row] of sessionRows.entries()) {
      if (!group.length) groupIsTask = Boolean(anchor)
      if (row.ID === taskId) {
        anchor = row
        groupIsTask = true
      }
      if (anchor && row.query?.inputRequired) {
        inputRequired = {
          position: index,
          interrupt: row.query.inputRequired,
          hitl: true,
        }
        pendingHitl.add(row.query?.toolCall?.id ?? row.ID)
      } else if (anchor && row.role === "tool" && row.type === "tool_result") {
        pendingHitl.delete(row.query?.toolCallId ?? row.ID)
      } else if (anchor && row.role === "user" && row.type === "decision") {
        decisions.push(decision(row.content))
      }
      group.push(row)

      const next = sessionRows[index + 1]
      if (next?.role === row.role && next.type === row.type) continue

      const [first] = group
      const message = a2aMessage(group, taskId, first.session)
      if (first.type === "text" && (first.role === "user" || first.role === "ai")) {
        history.push(message)
        if (first.role === "ai") response = { position: index, message }
      }
      if (groupIsTask && first.role === "ai") {
        if (first.type in { "auth-required": 1, canceled: 1, failed: 1, rejected: 1 })
          terminal = {
            state: first.type,
            message,
            timestamp: first.createdAt,
          }
      }
      group = []
      groupIsTask = false
    }

    const artifacts = []
    const awaitingInput = inputRequired && (!inputRequired.hitl || pendingHitl.size)
    const taskStatus = terminal
      ? terminal
      : awaitingInput && (!response || inputRequired.position >= response.position)
        ? {
            state: "input-required",
            message: withDecisions(
              inputRequired.message || hitlMessage(inputRequired.interrupt, taskId, anchor.session),
              decisions,
            ),
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

function hitlMessage(interrupt, taskId, contextId) {
  const value = (Array.isArray(interrupt) ? interrupt[0] : interrupt)?.value ?? interrupt
  const actionRequests = value.actionRequests
  return {
    kind: "message",
    messageId: actionRequests[0]?.id ?? cds.utils.uuid(),
    role: "agent",
    parts: [
      {
        kind: "text",
        text: actionRequests[0]?.description || "This action requires approval.",
      },
      { kind: "data", data: value },
    ],
    metadata: {
      "sap.cds.agents.hitl": { actionCount: actionRequests.length, decisions: [], actionRequests },
    },
    taskId,
    contextId,
  }
}

function withDecisions(message, decisions) {
  if (!decisions.length) return message
  const hitl = message.metadata?.["sap.cds.agents.hitl"]
  const action = hitl?.actionRequests?.[decisions.length]
  return {
    ...message,
    parts: [
      { kind: "text", text: action?.description || message.parts[0].text },
      ...message.parts.slice(1),
    ],
    metadata: { ...message.metadata, "sap.cds.agents.hitl": { ...hitl, decisions } },
  }
}

function decision(content) {
  if (/^(approve|yes|confirm|ok)$/i.test(content.trim())) return { type: "approve" }
  if (/^edit$/i.test(content.trim())) return { type: "edit" }
  return { type: "reject", message: content }
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
