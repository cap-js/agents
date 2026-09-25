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

function serialize(v) {
  return resolvePseudonyms(typeof v === "string" ? v : JSON.stringify(v))
}

/**
 * Publishes an artifact-update for a tool call (start or end).
 */
function publishToolCallArtifact(tc, { toolTypes, status, lastChunk, result }) {
  const eventBus = cds.context?.["agent.eventBus"]
  const config = toolCallConfig()
  if (!eventBus || !config.enabled) return

  eventBus.publish({
    kind: "artifact-update",
    taskId: cds.context["agent.task.id"],
    contextId: cds.context["agent.context.id"],
    append: false,
    lastChunk,
    artifact: {
      artifactId: `tool-call-${tc.id}`,
      parts: [
        {
          kind: "data",
          data: {
            type: "tool-call",
            name: tc.name,
            label: resolveToolLabel(tc),
            kind: resolveToolKind(tc, toolTypes),
            status,
            ...(config.args && { args: serialize(tc.args) }),
            ...(result !== undefined && config.result && { result: serialize(result) }),
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
  if (!ToolMessage.isInstance(msgs[msgs.length - 1])) return {}

  // Collect trailing ToolMessages
  const firstToolIdx = msgs.findLastIndex((m) => !ToolMessage.isInstance(m)) + 1
  const toolMsgs = msgs.slice(firstToolIdx)

  // Find the preceding AIMessage and build a map of tool call id → tc
  const tcMap = {}
  const msg = msgs.findLast((m) => AIMessage.isInstance(m) && m.tool_calls?.length)
  if (msg) for (const tc of msg.tool_calls) tcMap[tc.id] = tc

  // Emit completion event for each ToolMessage
  for (const tm of toolMsgs) {
    const tc = tcMap[tm.tool_call_id]
    if (tc && toolTypes.has(tc.name)) {
      publishToolCallArtifact(tc, {
        toolTypes,
        status: tm.status === "error" ? "error" : "done",
        lastChunk: true,
        result: tm.content,
      })
    }
  }

  // Plural if multiple tool messages
  const plural = toolMsgs.length >= 2
  const key = plural ? "agent_status_processing_responses" : "agent_status_processing_response"
  publishStatus(cds.i18n.messages.at(key))

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

  // Resolve label+kind once per tool call, filter to known tools
  const resolved = toolCalls
    .filter((tc) => toolTypes.has(tc.name))
    .map((tc) => ({ tc, label: resolveToolLabel(tc), kind: resolveToolKind(tc, toolTypes) }))

  const queryCalls = resolved.filter(({ kind }) => kind === "query")
  const otherCalls = resolved.filter(({ kind }) => kind !== "query")

  // Emit "Querying {entities}" for query tools
  if (queryCalls.length) {
    const text = cds.i18n.messages.at("agent_status_querying", [queryCalls.map(({ label }) => label).join(", ")])
    publishStatus(text)
  }

  // Emit "Calling {action labels}" for other tools
  if (otherCalls.length) {
    const text = cds.i18n.messages.at("agent_status_calling_tools", [otherCalls.map(({ label }) => label).join(", ")])
    publishStatus(text)
  }

  // Emit tool-call start events for all known tool calls
  for (const { tc } of resolved) {
    publishToolCallArtifact(tc, { toolTypes, status: "running", lastChunk: false })
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
