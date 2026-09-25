import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { resolvePseudonyms } from "../../masking/index.js"

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
 * Resolves the kind ("query" | "action" | "agent") for a tool call.
 */
function resolveToolKind(tc, toolTypes) {
  if (tc.name === "query" || tc.name?.endsWith("_query")) return "query"
  return toolTypes.get(tc.name) ?? "action"
}

/**
 * Publishes a non-final "working" status-update to the eventBus.
 */
export function publishStatus(text) {
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
 * Reads tool-call visibility config from the current request's metadata.
 * Controlled entirely by the client: presence of userMessage.metadata["tool-status-update"] enables it.
 */
function toolCallConfig() {
  const requestMeta = cds.context?.["agent.request.metadata"]?.["tool-status-update"]
  return {
    enabled: requestMeta !== undefined,
    args: requestMeta?.args ?? true,
    result: requestMeta?.result ?? true,
  }
}

/**
 * Publishes an artifact-update marking a tool call as started (running).
 */
function publishToolCallStart(tc, label, kind) {
  const eventBus = cds.context?.["agent.eventBus"]
  if (!eventBus) return

  const { enabled, args: showArgs } = toolCallConfig()
  if (!enabled) return

  eventBus.publish({
    kind: "artifact-update",
    taskId: cds.context["agent.task.id"],
    contextId: cds.context["agent.context.id"],
    append: false,
    lastChunk: false,
    artifact: {
      artifactId: `tool-call-${tc.id}`,
      parts: [
        {
          kind: "data",
          data: {
            type: "tool-call",
            name: tc.name,
            label,
            kind,
            status: "running",
            ...(showArgs && { args: tc.args }),
          },
        },
      ],
    },
  })
}

/**
 * Publishes an artifact-update marking a tool call as completed or errored.
 */
function publishToolCallEnd(tc, result, isError) {
  const eventBus = cds.context?.["agent.eventBus"]
  if (!eventBus) return

  const { enabled, args: showArgs, result: showResult } = toolCallConfig()
  if (!enabled) return

  eventBus.publish({
    kind: "artifact-update",
    taskId: cds.context["agent.task.id"],
    contextId: cds.context["agent.context.id"],
    append: false,
    lastChunk: true,
    artifact: {
      artifactId: `tool-call-${tc.id}`,
      parts: [
        {
          kind: "data",
          data: {
            type: "tool-call",
            name: tc.name,
            label: tc._label,
            kind: tc._kind,
            status: isError ? "error" : "done",
            ...(showArgs && { args: tc.args }),
            ...(showResult && {
              result: resolvePseudonyms(
                typeof result === "string" ? result : JSON.stringify(result),
              ),
            }),
          },
        },
      ],
    },
  })
}

/**
 * beforeModel hook: emit "Processing tool response" + tool-call completion events.
 */
export function beforeModelHook(state, toolTypes) {
  if (!cds.context?.["agent.eventBus"]) return {}

  const msgs = state.messages
  if (!msgs?.length) return {}
  const lastMsg = msgs[msgs.length - 1]
  if (!ToolMessage.isInstance(lastMsg)) return {}

  // Collect trailing ToolMessages
  let i = msgs.length - 1
  const toolMsgs = []
  while (i >= 0 && ToolMessage.isInstance(msgs[i])) {
    toolMsgs.unshift(msgs[i])
    i--
  }

  // Find the preceding AIMessage and build a map of tool call id → {name, args, label, kind}
  const tcMap = {}
  while (i >= 0) {
    const msg = msgs[i]
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        tcMap[tc.id] = {
          id: tc.id,
          name: tc.name,
          args: tc.args,
          _label: resolveToolLabel(tc),
          _kind: resolveToolKind(tc, toolTypes),
        }
      }
      break
    }
    i--
  }

  // Emit completion event for each ToolMessage
  for (const tm of toolMsgs) {
    const tc = tcMap[tm.tool_call_id]
    if (tc) publishToolCallEnd(tc, tm.content, tm.status === "error")
  }

  // Plural if multiple tool messages
  const plural = toolMsgs.length >= 2
  const key = plural ? "agent_status_processing_responses" : "agent_status_processing_response"
  const text = cds.i18n.messages.at(key)
  publishStatus(text)

  return {}
}

/**
 * afterModel hook: emit tool-call status updates (querying/calling) + tool-call start events.
 */
export function afterModelHook(state, toolTypes) {
  if (!cds.context?.["agent.eventBus"]) return {}

  const msgs = state.messages
  if (!msgs?.length) return {}

  const lastAI = msgs[msgs.length - 1]
  const toolCalls = lastAI?.tool_calls
  if (!toolCalls?.length) return {}

  // Separate query calls from action calls for status text
  const queryCalls = toolCalls.filter((tc) => tc.name === "query" || tc.name?.endsWith("_query"))
  const otherCalls = toolCalls.filter((tc) => tc.name !== "query" && !tc.name?.endsWith("_query"))

  // Emit "Querying {entities}" for query tools
  if (queryCalls.length) {
    const labels = queryCalls.map((tc) => resolveToolLabel(tc))
    const text = cds.i18n.messages.at("agent_status_querying", [labels.join(", ")])
    publishStatus(text)
  }

  // Emit "Calling {action labels}" for other tools
  if (otherCalls.length) {
    const labels = otherCalls.map((tc) => resolveToolLabel(tc))
    const text = cds.i18n.messages.at("agent_status_calling_tools", [labels.join(", ")])
    publishStatus(text)
  }

  // Emit tool-call start events for all tool calls
  for (const tc of toolCalls) {
    publishToolCallStart(tc, resolveToolLabel(tc), resolveToolKind(tc, toolTypes))
  }

  return {}
}

/**
 * Middleware factory that emits non-final status-update events during agent execution:
 * - beforeModel: "Processing tool response" after tools finish + tool-call completion events
 * - afterModel:  "Querying <entity>" / "Calling <action>" before tools are invoked + tool-call start events
 *
 * @param {Array} tools - the agent's tool list, used to resolve tool kinds
 */
export async function statusUpdateMiddleware(tools = []) {
  const toolTypes = new Map(tools.map((t) => [t.name, t.metadata?.kind ?? "action"]))

  return createMiddleware({
    name: "statusUpdateMiddleware",
    beforeModel: { hook: (state) => beforeModelHook(state, toolTypes) },
    afterModel: { hook: (state) => afterModelHook(state, toolTypes) },
  })
}
