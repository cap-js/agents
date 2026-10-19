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
  return (
    (def && cds.i18n?.labels?.at(def)) ||
    (fq.includes(".") ? fq.slice(fq.lastIndexOf(".") + 1) : fq)
  )
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
function resolveToolLabel(tc, meta, kind = resolveToolKind(tc, meta)) {
  const model = cds.context?.model ?? cds.model
  const serviceName = meta?.serviceName ?? cds.context?.["agent.service"] // REVISIT: why are we using cds.context here?

  if (kind === "agent") {
    return declaredServiceLabel(meta?.serviceName) || meta?.agentName || tc.name
  }

  if (kind === "describe") {
    let parts = []
    if (tc.args?.entities)
      parts.push(...tc.args.entities.map((e) => entityLabel(e, serviceName, model)))
    if (tc.args?.actions)
      parts.push(...tc.args.actions.map((a) => entityLabel(a, serviceName, model)))
    if (!parts.length) parts.push(serviceLabel(serviceName) || tc.name)
    return parts.join(", ")
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
  const actionName = meta?.actionName ?? tc.args?.action ?? tc.name
  if (serviceName) {
    const actionDef = model?.definitions?.[`${serviceName}.${actionName}`]
    const declared = (actionDef && cds.i18n?.labels?.at(actionDef)) || actionName
    if (declared) return withService(declared)
  }
  return withService(actionName)
}

/**
 * Publishes a non-final "working" status-update to the eventBus.
 */
export function publishStatus(text, context = cds.context) {
  const eventBus = context?.["agent.eventBus"]
  if (!eventBus || !text) return

  eventBus.publish({
    kind: "status-update",
    taskId: context["agent.task.id"],
    contextId: context["agent.context.id"],
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

  let kind = resolveToolKind(tc, meta)
  let label = resolveToolLabel(tc, meta)
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
            kind,
            label,
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
  const taskId = cds.context["agent.task.id"]
  if (taskId) pendingStatusMessages.get(taskId)?.reject()

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

const pendingStatusMessages = new Map()

function publishStatusWhenReady(taskId, message, context) {
  if (!taskId) {
    message.then((text) => publishStatus(text, context)).catch(() => {})
    return
  }

  let reject
  const cancelled = new Promise((_, rejectPromise) => {
    reject = rejectPromise
  })
  pendingStatusMessages.set(taskId, { reject })

  // Promise race, in case a SELECT takes
  // longer than the next update message, that no wrong message is send
  Promise.race([message, cancelled])
    .then((text) => publishStatus(text, context))
    .catch(() => {})
    .finally(() => {
      if (pendingStatusMessages.get(taskId)?.reject === reject) pendingStatusMessages.delete(taskId)
    })
}

function annotationValue(value) {
  return typeof value === "string" ? value : (value?.["="] ?? value?.["#"] ?? value?.ref?.at(-1))
}

function annotationPath(value) {
  if (value?.xpr) return value.xpr.map(annotationPath).find(Boolean)
  return value?.ref?.join(".") ?? annotationValue(value)
}

function elementAtPath(model, entity, path) {
  let current = entity
  let element
  for (const segment of path.split(".")) {
    element = current?.elements?.[segment]
    if (!element) return {}
    current = model.definitions[element.target]
  }
  return { element }
}

function textPathFor(valuePath, textPath) {
  if (textPath.includes(".")) return textPath
  const parentPath =
    valuePath.lastIndexOf(".") >= 0 ? valuePath.slice(0, valuePath.lastIndexOf(".")) : undefined
  return parentPath ? `${parentPath}.${textPath}` : textPath
}

function valueListFor(parameter) {
  return (
    parameter?.["@Common.ValueList"] ?? {
      CollectionPath: parameter?.["@Common.ValueList.CollectionPath"],
      Parameters: parameter?.["@Common.ValueList.Parameters"],
    }
  )
}

function valueListDisplay(value, text, arrangement) {
  if (text === undefined) return value
  if (arrangement === "TextOnly") return String(text)
  if (arrangement === "TextFirst") return `${text} (${value})`
  if (arrangement === "TextLast") return `${value} (${text})`
  if (arrangement === "TextSeparate") return `${value} — ${text}`
  return `${value} (${text})`
}

/**
 * Resolves text to display based on an annotated value list
 * Logic considers Common.ExternalID, Common.Text, Common.TextArrangement
 * Not yet supported: Measure.Unit, Measure.ISOCurrency and other numeric value formatter
 */
async function valueListTextArg(name, args, actionDef, serviceName, model) {
  const parameter = actionDef.params?.[name]
  const valueList = valueListFor(parameter)
  const collectionPath = valueList.CollectionPath
  const collection =
    collectionPath &&
    (model.definitions[collectionPath] ?? model.definitions[`${serviceName}.${collectionPath}`])
  const mappings = valueList.Parameters ?? []
  const mapping = mappings.find((m) => {
    const type = m.$Type ?? ""
    return (
      /ValueListParameter(In|InOut)$/.test(type) && annotationValue(m.LocalDataProperty) === name
    )
  })
  const valueListProperty = annotationValue(mapping?.ValueListProperty)
  if (!valueListProperty) return
  const valueListElement = collection?.elements?.[valueListProperty]
  const externalIdProperty = annotationPath(valueListElement?.["@Common.ExternalID"])
  const displayProperty = externalIdProperty ?? valueListProperty
  const displayElement = elementAtPath(model, collection, displayProperty).element
  const textProperty = annotationPath(displayElement?.["@Common.Text"])
  const fullTextPath = textProperty && textPathFor(displayProperty, textProperty)
  if (!collection || !displayElement || args[name] === undefined) return

  const where = Object.fromEntries(
    mappings
      .filter((m) => /ValueListParameter(In|InOut)$/.test(m.$Type ?? ""))
      .map((m) => [
        annotationValue(m.ValueListProperty),
        args[annotationValue(m.LocalDataProperty)],
      ])
      .filter(([property, value]) => property && value !== undefined),
  )
  if (!Object.keys(where).length) return

  const valueAlias = "__status_update_value"
  const textAlias = "__status_update_text"
  const cols = [{ ref: displayProperty.split("."), as: valueAlias }]
  if (fullTextPath) cols.push({ ref: fullTextPath.split("."), as: textAlias })
  const row = await SELECT.one.from(collection.name).columns(cols).where(where)
  const value = row?.[valueAlias]
  if (value === undefined) return

  return valueListDisplay(
    value,
    row?.[textAlias],
    annotationValue(
      displayElement["@Common.TextArrangement"] ?? parameter["@Common.TextArrangement"],
    ),
  )
}

async function valueListTextArgs(template, args, actionDef, serviceName, model) {
  const placeholders = [...new Set([...template.matchAll(/{(\w+)}/g)].map(([, name]) => name))]
  const values = await Promise.all(
    placeholders.map(async (name) => [
      name,
      await valueListTextArg(name, args, actionDef, serviceName, model),
    ]),
  )
  return Object.assign(
    { ...args },
    ...values
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ [name]: value })),
  )
}

/**
 * Custom status message for single call actions. "Activating the sales order" instead of "Calling Activate Sales Order"
 * Furthermore a Fiori annotation lookup is performed, so that messages like "Deleting sales order",
 * can carry the actual identifier instead of a technical one.
 */
async function statusMessageForCall({ meta, tc, label }) {
  const model = cds.context?.model ?? cds.model
  const serviceName = meta?.serviceName ?? cds.context?.["agent.service"]
  const actionName = meta?.actionName ?? tc.args?.action ?? tc.name
  const actionDef = model?.definitions?.[`${serviceName}.${actionName}`]
  const customMessage = actionDef?.["@Core.Messages"]?.find((m) => m.code === "agent-status-update")
  if (!customMessage) return label

  const messageKey = customMessage.message?.startsWith("{i18n>")
    ? customMessage.message.slice(6, -1)
    : customMessage.message
  const args = tc.args?.parameters
  const template = cds.i18n.messages.at(messageKey) ?? customMessage.message
  const displayArgs = await valueListTextArgs(template, args, actionDef, serviceName, model)
  return (
    cds.i18n.messages.at(messageKey, displayArgs) ??
    template.replace(/{(\w+)}/g, (_, name) => displayArgs[name])
  )
}

/**
 * afterModel hook: emit tool-call status updates (querying/inspecting/calling)
 * + tool-call start events.
 */
export function afterModelHook(state, toolMeta) {
  if (!cds.context?.["agent.eventBus"]) return {}
  const context = cds.context
  const taskId = context["agent.task.id"]

  const msgs = state.messages
  if (!msgs?.length) return {}

  const lastAI = msgs[msgs.length - 1]
  const toolCalls = lastAI?.tool_calls
  if (!toolCalls?.length) return {}

  const resolved = toolCalls
    .map((tc) => ({ tc, meta: resolveMeta(tc, toolMeta) }))
    .filter(({ meta }) => meta)
    .map(({ tc, meta }) => {
      let kind = resolveToolKind(tc, meta)
      let label = resolveToolLabel(tc, meta, kind)
      return { tc, meta, kind, label }
    })

  const queryCalls = resolved.filter(({ kind }) => kind === "query")
  const describeCalls = resolved.filter(({ kind }) => kind === "describe")
  const otherCalls = resolved.filter(({ kind }) => kind !== "query" && kind !== "describe")

  if (queryCalls.length) {
    publishStatus(cds.i18n.messages.at("agent_status_querying", [uniqueLabels(queryCalls)]))
  } else if (describeCalls.length) {
    publishStatus(cds.i18n.messages.at("agent_status_describing", [uniqueLabels(describeCalls)]))
  } else if (otherCalls.every(({ tc }) => tc === "task")) {
    publishStatus(
      otherCalls.length > 1
        ? cds.i18n.messages.at("agent_status_spawning_subagents")
        : cds.i18n.messages.at("agent_status_spawning_subagent"),
    )
  } else if (otherCalls.length === 1) {
    publishStatusWhenReady(taskId, statusMessageForCall(otherCalls[0]), context)
  } else if (otherCalls.length) {
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

  const deepAgentDefault = (tool, i18nKey) => {
    if (!toolMeta.get(tool))
      toolMeta.set(tool, { serviceName: null, actionName: cds.i18n.messages.for(i18nKey) })
  }
  deepAgentDefault("ls", "memory_tools_ls")
  deepAgentDefault("read_file", "memory_tool_read_file")
  deepAgentDefault("write_file", "memory_tool_write_file")
  deepAgentDefault("edit_file", "memory_tool_edit_file")
  deepAgentDefault("delete", "memory_tool_delete")
  deepAgentDefault("glob", "memory_tool_glob")
  deepAgentDefault("grep", "memory_tool_grep")

  return createMiddleware({
    name: "statusUpdateMiddleware",
    beforeModel: { hook: (state) => beforeModelHook(state, toolMeta) },
    afterModel: { hook: (state) => afterModelHook(state, toolMeta) },
  })
}
