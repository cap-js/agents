const cds = require("@sap/cds")
const { getFilteredEntities } = require("../utils")

/**
 * Mock Executor Service.
 * Queries a sample data entry from the first entity in the CDS service.
 * Supports HITL demo: messages containing "hitl" transition to input-required.
 */
module.exports = class MockExecutorService extends cds.Service {
  for(srv) {
    return {
      execute: (requestContext, eventBus) => this._execute(srv, requestContext, eventBus),
      cancelTask: (taskId, eventBus) => this._cancelTask(taskId, eventBus),
    }
  }

  async _execute(srv, requestContext, eventBus) {
    const { taskId, contextId } = requestContext

    const userText =
      requestContext.userMessage?.parts
        ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
        .map((p) => p.text)
        .join(" ") || ""

    const isResume = requestContext.task?.status?.state === "input-required"

    eventBus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
    })

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    })

    // ── HITL resume ─────────────────────────────────────────────
    if (isResume) {
      const approved = /yes|approve|confirm|ok/i.test(userText)
      const state = approved ? "completed" : "canceled"
      const text = approved
        ? "Action approved and executed successfully."
        : "Action canceled by user."

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state,
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "agent",
            parts: [{ kind: "text", text }],
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      })
      eventBus.finished()
      return
    }

    // ── HITL request ────────────────────────────────────────────
    if (/hitl/i.test(userText)) {
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "input-required",
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "agent",
            parts: [
              {
                kind: "text",
                text: "This action requires your approval. Reply 'yes' to proceed or 'no' to cancel.",
              },
            ],
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      })
      eventBus.finished()
      return
    }

    // ── Default: query first entity and return sample data ──────
    let text = "No data found."
    try {
      const entities = getFilteredEntities(srv)
      const firstName = Object.keys(entities)[0]
      if (firstName) {
        const result = await srv.run(SELECT.from(firstName).limit(1))
        if (result?.length > 0) {
          text = `Here is a sample from ${firstName}:\n${JSON.stringify(result[0], null, 2)}`
        }
      }
    } catch {
      text = "Could not query data from the service."
    }

    eventBus.publish({
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: { artifactId: "response", parts: [{ text }] },
    })

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "agent",
          parts: [{ kind: "text", text }],
        },
        timestamp: new Date().toISOString(),
      },
      final: true,
    })

    eventBus.finished()
  }

  async _cancelTask(taskId, eventBus) {
    eventBus.publish({
      kind: "status-update",
      taskId,
      status: {
        state: "canceled",
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "agent",
          parts: [{ kind: "text", text: "Task canceled." }],
        },
        timestamp: new Date().toISOString(),
      },
      final: true,
    })
    eventBus.finished()
  }
}
