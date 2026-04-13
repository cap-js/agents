const cds = require("@sap/cds")

/**
 * Mock Executor Service.
 * Returns a completed task with a placeholder response.
 * Supports HITL demo: messages containing "hitl" transition to input-required.
 */
module.exports = class MockExecutorService extends cds.Service {
  async execute(requestContext, eventBus) {
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

    // ── Default ─────────────────────────────────────────────────
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
          parts: [{ kind: "text", text: "Agent execution not yet implemented." }],
        },
        timestamp: new Date().toISOString(),
      },
      final: true,
    })

    eventBus.finished()
  }

  async cancelTask(taskId, eventBus) {
    eventBus.finished()
  }
}
