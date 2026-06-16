import cds from "@sap/cds"
import { getFilteredEntities } from "../utils.js"
import { agentMessage } from "../system-prompt.js"
import * as metrics from "../telemetry/metrics.js"

/**
 * Mock Executor Service.
 * Queries a sample data entry from the first entity in the CDS service.
 * Supports HITL demo: messages containing "hitl" transition to input-required.
 */
export default class MockExecutorService extends cds.Service {
  for(srv) {
    return {
      execute: (requestContext, eventBus) => this._execute(srv, requestContext, eventBus),
      cancelTask: (taskId, eventBus) => this._cancelTask(taskId, eventBus),
    }
  }

  async _execute(srv, requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const serviceName = srv.name
    const mAttrs = metrics.attrs(srv)

    metrics.concurrentExecutions.add(1, mAttrs)

    // A2A correlation on HTTP span + log context
    const httpSpan = metrics.getActiveSpan()
    if (httpSpan) {
      httpSpan.setAttribute("agent.task.id", taskId)
      httpSpan.setAttribute("agent.context.id", contextId)
    }
    if (cds.context) {
      cds.context["agent.task.id"] = taskId
      cds.context["agent.context.id"] = contextId
    }

    const tracer = metrics.getTracer()
    const runWorkflow = async (wfSpan) => {
      if (wfSpan) {
        wfSpan.setAttribute("gen_ai.operation.name", "invoke_agent")
        wfSpan.setAttribute("gen_ai.agent.name", serviceName)
        wfSpan.setAttribute("agent.span.kind", "workflow")
        wfSpan.setAttribute("agent.task.id", taskId)
        wfSpan.setAttribute("agent.context.id", contextId)
      }

      try {
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

          if (wfSpan) wfSpan.setAttribute("agent.outcome", state)
          if (approved) {
            metrics.workflowsCompleted.add(1, mAttrs)
            metrics.agentActions.add(1, { "sap.tenantId": mAttrs["sap.tenantId"] })
          }

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state,
              message: agentMessage(text),
              timestamp: new Date().toISOString(),
            },
            final: true,
          })
          return
        }

        // ── HITL request ────────────────────────────────────────────
        if (/hitl/i.test(userText)) {
          if (wfSpan) wfSpan.setAttribute("agent.outcome", "input-required")

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state: "input-required",
              message: agentMessage(
                "This action requires your approval. Reply 'yes' to proceed or 'no' to cancel.",
              ),
              timestamp: new Date().toISOString(),
            },
            final: true,
          })
          return
        }

        // ── Default: query first entity and return sample data ──────
        // The inner try/catch around SELECT preserves existing UX —
        // a DB failure becomes a "completed" workflow with a fallback text.
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

        if (wfSpan) wfSpan.setAttribute("agent.outcome", "completed")
        metrics.workflowsCompleted.add(1, mAttrs)
        metrics.agentActions.add(1, { "sap.tenantId": mAttrs["sap.tenantId"] })

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
            message: agentMessage(text),
            timestamp: new Date().toISOString(),
          },
          final: true,
        })
      } catch (err) {
        if (wfSpan) {
          wfSpan.setAttribute("agent.outcome", "failed")
          wfSpan.setStatus({ code: 2, message: err.message })
        }
        metrics.errorsTotal.add(1, { ...mAttrs, "agent.error.code": "execution_failed" })

        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: "failed",
            message: agentMessage(`Mock executor error: ${err.message}`),
            timestamp: new Date().toISOString(),
          },
          final: true,
        })
      } finally {
        metrics.concurrentExecutions.add(-1, mAttrs)
      }

      eventBus.finished()
    }

    if (tracer) {
      await tracer.startActiveSpan(`workflow MockExecutor ${serviceName}`, async (wfSpan) => {
        try {
          await runWorkflow(wfSpan)
        } finally {
          wfSpan.end()
        }
      })
    } else {
      await runWorkflow(null)
    }
  }

  async _cancelTask(taskId, eventBus) {
    eventBus.publish({
      kind: "status-update",
      taskId,
      status: {
        state: "canceled",
        message: agentMessage("Task canceled."),
        timestamp: new Date().toISOString(),
      },
      final: true,
    })
    eventBus.finished()
  }
}
