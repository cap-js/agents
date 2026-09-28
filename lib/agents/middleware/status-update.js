import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { resolvePseudonyms } from "../../masking/index.js"
import { serviceLabel, declaredServiceLabel, mcpToolKind } from "../../utils/utils.js"

/**
 * Resolve the metadata for a tool call, or undefined when the tool is unknown.
 * Static tools come from the precomputed `toolMeta` map; remote MCP tools are
 * resolved per-request from cds.context.__mcpDynamicTools.
 */
function resolveMeta(tc, toolMeta) {
  const meta = toolMeta.get(tc.name)
  if (meta) return meta

  const cache = cds.context?.__mcpDynamicTools
  if (cache) {
    for (const entry of Object.values(cache)) {
      const t = entry.tools?.find((t) => t.name === tc.name)
      if (t) return t.metadata
    }
  }
  return undefined
}

/**
 * Resolve the kind ("query" | "describe" | "action" | "agent") for a tool call.
 * Prefer the build-time `meta.kind` (classified from the unprefixed name, so it
 * survives prefixing/truncation); else sniff `tc.name` for own-service tools.
 */
function resolveToolKind(tc, meta) {
  if (meta?.kind) return meta.kind
  return mcpToolKind(tc.name)
}

/** Resolve an entity's display label (declared i18n label, else its simple name). */
function entityLabel(name, serviceName, model) {
  const fq = serviceName && !name.startsWith(serviceName + ".") ? `${serviceName}.${name}` : name
  const def = model?.definitions?.[fq]
  return (def && cds.i18n?.labels?.at(def)) || (fq.includes(".") ? fq.slice(fq.lastIndexOf(".") + 1) : fq)
}

/** Resolve the query target: the `entity` arg, or the FROM target parsed from `cql`. */
function queryTarget(tc) {
  if (tc.args?.entity) return tc.args.entity
  if (tc.args?.cql) {
    try {
      const ref0 = cds.parse.cql(tc.args.cql).SELECT?.from?.ref?.[0]
      return ref0?.id ?? ref0 ?? undefined
    } catch {
      /* no target derivable */
    }
  }
  return undefined
}

/**
 * Resolve a human-readable label for a tool call:
 * - agent    → declared service label, else the subagent's agent-card name
 * - describe → service label (declared, else the FQ service name)
 * - query    → entity label, prefixed with the service only when it has a declared label
 * - action   → action label, prefixed with the service only when it has a declared label
 */
function resolveToolLabel(tc, meta) {
  const kind = resolveToolKind(tc, meta)
  const model = cds.context?.model ?? cds.model
  const serviceName = meta?.serviceName ?? cds.context?.["agent.service"]

  if (kind === "agent") {
    return declaredServiceLabel(meta?.serviceName) || meta?.agentName || tc.name
  }

  if (kind === "describe") {
    return serviceLabel(serviceName) || tc.name
  }

  const svcLabel = declaredServiceLabel(serviceName)
  const withService = (detail) => (svcLabel ? `${svcLabel} · ${detail}` : detail)

  if (kind === "query") {
    const target = queryTarget(tc)
    if (target) return withService(entityLabel(target, serviceName, model))
    return svcLabel || tc.name
  }

  // meta.actionName is the un-prefixed name for MCP action tools (tc.name is
  // "{service}_{action}"); own-service tools already carry the bare name.
  const actionName = meta?.actionName ?? tc.name
  if (serviceName) {
    const actionDef = model?.definitions?.[`${serviceName}.${actionName}`]
    const declared = actionDef && cds.i18n?.labels?.at(actionDef)
    if (declared) return withService(declared)
  }
  return withService(actionName)
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
function publishToolCallArtifact(tc, { meta, status, lastChunk, result }) {
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
            label: resolveToolLabel(tc, meta),
            kind: resolveToolKind(tc, meta),
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
export function beforeModelHook(state, toolMeta) {
  if (!cds.context?.["agent.eventBus"]) return {}

  const msgs = state.messages
  if (!msgs?.length) return {}
  if (!ToolMessage.isInstance(msgs[msgs.length - 1])) return {}

  const firstToolIdx = msgs.findLastIndex((m) => !ToolMessage.isInstance(m)) + 1
  const toolMsgs = msgs.slice(firstToolIdx)

  const tcMap = {}
  const msg = msgs.findLast((m) => AIMessage.isInstance(m) && m.tool_calls?.length)
  if (msg) for (const tc of msg.tool_calls) tcMap[tc.id] = tc

  for (const tm of toolMsgs) {
    const tc = tcMap[tm.tool_call_id]
    if (!tc) continue
    const meta = resolveMeta(tc, toolMeta)
    if (meta) {
      publishToolCallArtifact(tc, {
        meta,
        status: tm.status === "error" ? "error" : "done",
        lastChunk: true,
        result: tm.content,
      })
    }
  }

  const plural = toolMsgs.length >= 2
  const key = plural ? "agent_status_processing_responses" : "agent_status_processing_response"
  publishStatus(cds.i18n.messages.at(key))

  return {}
}

/** De-duplicate labels while preserving order. */
function uniqueLabels(calls) {
  return [...new Set(calls.map(({ label }) => label))].join(", ")
}

/**
 * afterModel hook: emit tool-call status updates (querying/inspecting/calling)
 * + tool-call start events.
 */
export function afterModelHook(state, toolMeta) {
  if (!cds.context?.["agent.eventBus"]) return {}

  const msgs = state.messages
  if (!msgs?.length) return {}

  const lastAI = msgs[msgs.length - 1]
  const toolCalls = lastAI?.tool_calls
  if (!toolCalls?.length) return {}

  const resolved = toolCalls
    .map((tc) => ({ tc, meta: resolveMeta(tc, toolMeta) }))
    .filter(({ meta }) => meta)
    .map(({ tc, meta }) => ({ tc, meta, label: resolveToolLabel(tc, meta), kind: resolveToolKind(tc, meta) }))

  const queryCalls = resolved.filter(({ kind }) => kind === "query")
  const describeCalls = resolved.filter(({ kind }) => kind === "describe")
  const otherCalls = resolved.filter(({ kind }) => kind !== "query" && kind !== "describe")

  if (queryCalls.length) {
    publishStatus(cds.i18n.messages.at("agent_status_querying", [uniqueLabels(queryCalls)]))
  }
  if (describeCalls.length) {
    publishStatus(cds.i18n.messages.at("agent_status_describing", [uniqueLabels(describeCalls)]))
  }
  if (otherCalls.length) {
    publishStatus(cds.i18n.messages.at("agent_status_calling_tools", [uniqueLabels(otherCalls)]))
  }

  for (const { tc, meta } of resolved) {
    publishToolCallArtifact(tc, { meta, status: "running", lastChunk: false })
  }

  return {}
}

/**
 * Middleware emitting non-final status-update events during agent execution:
 * - beforeModel: "Processing tool response" + tool-call completion events
 * - afterModel:  "Querying"/"Inspecting"/"Calling" + tool-call start events
 *
 * Static tools are captured here; remote MCP tools are resolved per-request from
 * cds.context.__mcpDynamicTools by resolveMeta().
 */
export async function statusUpdateMiddleware(tools = []) {
  // Presence in the map marks a tool as "known"; own-service tools carry no
  // metadata (→ {}), so resolveToolKind sniffs their kind from the name.
  const toolMeta = new Map(tools.map((t) => [t.name, t.metadata ?? {}]))

  return createMiddleware({
    name: "statusUpdateMiddleware",
    beforeModel: { hook: (state) => beforeModelHook(state, toolMeta) },
    afterModel: { hook: (state) => afterModelHook(state, toolMeta) },
  })
}
