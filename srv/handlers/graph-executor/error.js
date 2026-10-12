import cds from "@sap/cds"
import { short } from "../../../lib/utils/utils.js"
import { agentMessage } from "../../../lib/utils/message-handling.js"
import { publishTimeoutHitl } from "./hitl.js"

const LOG = cds.log("agents")

function publishFinalStatus(state, message) {
  cds.context["agent.eventBus"].publish({
    kind: "status-update",
    taskId: cds.context["agent.task.id"],
    contextId: cds.context["agent.context.id"],
    status: {
      state,
      message: agentMessage(message),
      timestamp: new Date().toISOString(),
    },
    final: true,
  })
}

async function handleWorkflowError(executor, err) {
  const requestContext = cds.context["agent"].request
  const eventBus = cds.context["agent.eventBus"]
  const serviceName = cds.context["agent.service"]
  const taskId = cds.context["agent.task.id"]
  const contextId = cds.context["agent.context.id"]
  if (err.name === "AbortError") {
    LOG.info(serviceName, "-", "canceled", { conversation: short(contextId) })
    publishFinalStatus("canceled", "Task canceled.")
    return
  }
  if (err.name === "TimeoutError") {
    LOG.warn(serviceName, "-", "timeout", { conversation: short(contextId) })
    const summary = await executor._summarizePartialWork(taskId, contextId, serviceName, "timeOut")
    publishTimeoutHitl({ requestContext, eventBus, description: summary, serviceName })
    return
  }
  if (err.quotaExceeded) {
    LOG.warn(serviceName, "-", "quota exceeded", {
      conversation: short(contextId),
      error: err.message,
    })
    const summary = await executor._summarizePartialWork(taskId, contextId, serviceName, "quota")
    publishFinalStatus("canceled", summary)
    return
  }
  LOG.error(Object.assign(err, { conversation: short(contextId) }))
  const production = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
  const message =
    production && err.$sanitize !== false
      ? cds.i18n.messages.at(500) || "Internal Server Error"
      : `Agent error: ${err.message}`
  publishFinalStatus("failed", message)
}

export { handleWorkflowError, publishFinalStatus }
