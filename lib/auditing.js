import cds from "@sap/cds"
import { partsToText } from "./utils/message-handling.js"
import { audit } from "./utils/utils.js"

export const AUDIT_CONTEXT_KEY = "sap.cds.agents.audit"

export function setAuditMetadata(metadata) {
  if (cds.context) cds.context[AUDIT_CONTEXT_KEY] = metadata
}

function auditExecutionEvent(event, service) {
  const auditMetadata = cds.context?.[AUDIT_CONTEXT_KEY] || {}
  if (cds.context) delete cds.context[AUDIT_CONTEXT_KEY]
  const requestContext = cds.context?.agent?.request
  const taskId = event.taskId || event.id
  const contextId = event.contextId

  if (event.kind === "task") {
    audit("AgentTaskStarted", {
      data: {
        taskId,
        contextId,
        service,
        userMessage: requestContext?.userMessage,
        ...auditMetadata,
      },
    })
    return
  }

  if (event.kind !== "status-update") return

  const state = event.status?.state
  const text = partsToText(event.status?.message?.parts)
  const duration = event.status?.message?.metadata?.["sap.cds.agents.duration"]
  if (state === "working" && requestContext?.task?.status?.state === "input-required") {
    audit("AgentTaskResumed", { data: { taskId, contextId, service } })
  } else if (state === "completed") {
    audit("AgentTaskCompleted", {
      data: { taskId, contextId, service, duration, ...auditMetadata },
    })
  } else if (state === "input-required") {
    audit("AgentInputRequired", {
      data: { taskId, contextId, service, description: text, ...auditMetadata },
    })
  } else if (state === "canceled") {
    audit("AgentTaskCanceled", {
      data: { taskId, contextId, service, message: text, ...auditMetadata },
    })
  } else if (state === "failed") {
    audit("AgentTaskFailed", {
      data: { taskId, contextId, service, error: text, ...auditMetadata },
    })
  }
}

export function createAuditingEventBusManager(DefaultExecutionEventBusManager, serviceName) {
  return new (class AuditingEventBusManager extends DefaultExecutionEventBusManager {
    auditedTaskIds = new Set()

    createOrGetByTaskId(taskId) {
      const bus = super.createOrGetByTaskId(taskId)
      if (!this.auditedTaskIds.has(taskId)) {
        this.auditedTaskIds.add(taskId)
        bus.on("event", (event) => auditExecutionEvent(event, serviceName))
      }
      return bus
    }

    cleanupByTaskId(taskId) {
      this.auditedTaskIds.delete(taskId)
      super.cleanupByTaskId(taskId)
    }
  })()
}
