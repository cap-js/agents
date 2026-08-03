import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"

/**
 * Resolves a human-readable label for a tool call.
 *
 * - query tool → resolves entity label from CDS model: @Common.Label, @title, or i18n
 * - actions → resolves label from action definition
 * - fallback → tool name as-is
 */
function resolveToolLabel(tc) {
  const serviceName = cds.context?.["agent.service"]
  const srv = serviceName && cds.services?.[serviceName]
  const model = cds.context?.model ?? cds.model

  // Query tool: extract entity target and resolve its label
  if (tc.name === "query" || tc.name?.endsWith("_query")) {
    let entityName = tc.args?.entity ? `${serviceName}.${tc.args.entity}` : undefined

    // SQL format: no entity arg — parse SQL to extract FROM target
    if (!entityName && tc.args?.cql) {
      try {
        const cqn = cds.parse.cql(tc.args.cql)
        const ref0 = cqn.SELECT?.from?.ref?.[0]
        const targetName = ref0?.id ?? ref0
        if (targetName && serviceName && !targetName.startsWith(serviceName + ".")) {
          entityName = `${serviceName}.${targetName}`
        } else {
          entityName = targetName
        }
      } catch {
        /* fallback to tc.name below */
      }
    }
    if (entityName) {
      const entityDef = model.definitions?.[entityName]
      if (entityDef) {
        const label = cds.i18n?.labels?.at(entityDef)
        if (label) return label
      }
    }
    // Fallback: strip service prefix if present
    if (entityName && srv?.name && entityName.startsWith(srv.name + ".")) {
      return entityName.slice(srv.name.length + 1)
    }
    return entityName || tc.name
  }

  // Action/function tools: resolve from service definition
  if (srv) {
    // Try as action on service
    const actionDef = model.definitions[`${srv.name}.${tc.name}`]
    if (actionDef) {
      const label = cds.i18n?.labels?.at(actionDef)
      if (label) return label
    }
  }

  return tc.name
}

/**
 * Publishes a non-final "working" status-update to the eventBus.
 */
function publishStatus(text) {
  const eventBus = cds.context?.["agent.eventBus"]
  if (!eventBus || !text) return

  eventBus.publish({
    kind: "status-update",
    taskId: cds.context["agent.task.id"],
    contextId: cds.context["agent.context.id"],
    status: {
      state: "working",
      message: {
        kind: "message",
        messageId: cds.utils.uuid(),
        role: "agent",
        parts: [{ kind: "text", text }],
      },
      timestamp: new Date().toISOString(),
    },
    final: false,
  })
}

/**
 * beforeModel hook: emit "Processing tool response" when tools just finished.
 */
export function beforeModelHook(state) {
  if (!cds.context?.["agent.eventBus"]) return {}

  const msgs = state.messages
  if (!msgs?.length) return {}
  const lastMsg = msgs[msgs.length - 1]
  if (!ToolMessage.isInstance(lastMsg)) return {}

  // Plural if second-to-last is also a ToolMessage
  const plural = msgs.length >= 2 && ToolMessage.isInstance(msgs[msgs.length - 2])
  const key = plural ? "agent_status_processing_responses" : "agent_status_processing_response"
  const text = cds.i18n.labels.at(key)
  publishStatus(text)

  return {}
}

/**
 * afterModel hook: emit tool-call status updates (querying/calling).
 */
export function afterModelHook(state) {
  if (!cds.context?.["agent.eventBus"]) return {}

  const msgs = state.messages
  if (!msgs?.length) return {}

  const lastAI = msgs[msgs.length - 1]
  const toolCalls = lastAI?.tool_calls
  if (!toolCalls?.length) return {}

  // Separate query calls from action calls
  const queryCalls = toolCalls.filter((tc) => tc.name === "query" || tc.name?.endsWith("_query"))
  const otherCalls = toolCalls.filter((tc) => tc.name !== "query" && !tc.name?.endsWith("_query"))

  // Emit "Querying {entities}" for query tools
  if (queryCalls.length) {
    const labels = queryCalls.map((tc) => resolveToolLabel(tc))
    const text = cds.i18n.labels.at("agent_status_querying", [labels.join(", ")])
    publishStatus(text)
  }

  // Emit "Calling {action labels}" for other tools
  if (otherCalls.length) {
    const labels = otherCalls.map((tc) => resolveToolLabel(tc))
    const text = cds.i18n.labels.at("agent_status_calling_tools", [labels.join(", ")])
    publishStatus(text)
  }

  return {}
}

/**
 * Middleware factory that emits non-final status-update events during agent execution:
 * - beforeModel: "Processing tool response" after tools finish
 * - afterModel:  "Querying <entity>" / "Calling <action>" before tools are invoked
 */
export async function statusUpdateMiddleware() {
  return createMiddleware({
    name: "statusUpdateMiddleware",
    beforeModel: { hook: beforeModelHook },
    afterModel: { hook: afterModelHook },
  })
}
