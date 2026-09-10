import cds from "@sap/cds"
import { agentMessage, firstDataPart, partsToText } from "../../../lib/utils/message-handling.js"
import { audit, short } from "../../../lib/utils/utils.js"

const LOG = cds.log("agents")

export const HITL_METADATA_KEY = "sap.cds.agents.hitl"
export const TIMEOUT_HITL_METADATA_KEY = "sap.cds.agents.timeout-hitl"
export const INPUT_REQUIRED_METADATA_KEY = "sap.cds.agents.input-required"

function approvalOptions() {
  return [
    { value: "approve", label: cds.i18n.messages.at("HITL_APPROVE") },
    { value: "reject", label: cds.i18n.messages.at("HITL_REJECT") },
  ]
}

function timeoutOptions() {
  return [
    { value: "continue", label: cds.i18n.messages.at("HITL_CONTINUE") },
    { value: "reject", label: cds.i18n.messages.at("HITL_STOP") },
  ]
}
export const requiresHitl = (result) =>
  result?.__interrupt__?.length > 0 || result?.interrupts?.length > 0

export function parseResumeDecision(userText) {
  const t = userText.trim()
  if (/^(approve|yes|confirm|ok)$/i.test(t)) return { decisions: [{ type: "approve" }] }
  if (/^edit$/i.test(t)) return { decisions: [{ type: "edit" }] }
  return {
    decisions: [
      {
        type: "reject",
        message: `The user rejected this particular tool invocation with the reason: ${userText}`,
      },
    ],
  }
}

function decisionsForAudit(resume, actionRequests = []) {
  if (!Array.isArray(resume?.decisions)) return [{ action: null, decision: resume }]
  return resume.decisions.map((decision, index) => ({
    action: actionRequests[index] ?? { index: index + 1 },
    decision,
  }))
}

function extractInterruptDescription(resultOrErr) {
  const interrupt = resultOrErr.__interrupt__?.[0] || resultOrErr.interrupts?.[0]
  const payload = interrupt?.value
  if (!payload) return "This action requires your approval. Reply 'approve' or 'reject'."
  if (payload.actionRequests?.length > 0) {
    return (
      payload.actionRequests[0].description || `Approve action: ${payload.actionRequests[0].name}?`
    )
  }
  return typeof payload === "string" ? payload : JSON.stringify(payload)
}

export function extractInterruptData(resultOrErr) {
  const interrupt = resultOrErr.__interrupt__?.[0] || resultOrErr.interrupts?.[0]
  const payload = interrupt?.value
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const actionRequests = mergeReviewConfigs(payload.actionRequests, payload.reviewConfigs)
  return actionRequests === payload.actionRequests ? payload : { ...payload, actionRequests }
}

function mergeReviewConfigs(actionRequests, reviewConfigs) {
  if (!Array.isArray(actionRequests) || !Array.isArray(reviewConfigs)) return actionRequests
  const configsByAction = new Map(reviewConfigs.map((config) => [config.actionName, config]))
  let changed = false
  const requests = actionRequests.map((request) => {
    const config = configsByAction.get(request.name)
    if (!config) return request
    changed = true
    const { allowedDecisions, argsSchema } = config
    return {
      ...request,
      ...(allowedDecisions === undefined ? {} : { allowedDecisions }),
      ...(argsSchema === undefined ? {} : { argsSchema }),
    }
  })
  return changed ? requests : actionRequests
}

function interruptActionCount(resultOrErr) {
  const interrupts = resultOrErr.__interrupt__ || resultOrErr.interrupts || []
  return interrupts.reduce(
    (count, interrupt) => count + (interrupt?.value?.actionRequests?.length || 0),
    0,
  )
}

function interruptActionRequests(resultOrErr) {
  const interrupts = resultOrErr.__interrupt__ || resultOrErr.interrupts || []
  return interrupts.flatMap((interrupt) => interrupt?.value?.actionRequests || [])
}

export function composeHitlDecisionNote(actionRequests, resume) {
  const decisions = resume?.decisions
  if (!Array.isArray(decisions) || decisions.length === 0) return undefined
  if (decisions.every((decision) => decision?.type === "approve")) return undefined
  const consumed = new Set()
  const takeByName = (name) => {
    for (let index = 0; index < actionRequests.length; index++) {
      if (!consumed.has(index) && actionRequests[index]?.name === name) {
        consumed.add(index)
        return actionRequests[index]
      }
    }
    return undefined
  }
  const action = (request) =>
    "`" + (request?.name ?? "unknown action") + "(" + JSON.stringify(request?.args ?? {}) + ")`"
  const lines = []
  for (const [index, decision] of decisions.entries()) {
    const original = actionRequests[index]
    if (decision?.type === "edit") {
      const matched = takeByName(decision.editedAction?.name) ?? original
      lines.push("- User edited " + action(matched) + " to " + action(decision.editedAction) + ".")
      continue
    }
  }
  if (!lines.length) {
    return undefined
  }
  return ["User HITL decisions (not tool failures):", ...lines].join("\n")
}

async function getPreInterruptToolCalls(graph, config) {
  try {
    if (typeof graph.getState !== "function") return []
    const state = await graph.getState(config)
    const messages = state?.values?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.tool_calls?.length) {
        return message.tool_calls.map((call) => ({ id: call.id, name: call.name, args: call.args }))
      }
    }
    return []
  } catch {
    return []
  }
}

async function getPendingHitlActionCount(graph, config) {
  if (typeof graph.getState !== "function") {
    throw new Error("Cannot resume HITL: graph state is unavailable.")
  }
  const state = await graph.getState(config)
  const interrupts = state?.tasks?.flatMap((task) => task.interrupts || []) || []
  const count = interrupts.reduce(
    (total, interrupt) => total + (interrupt?.value?.actionRequests?.length || 1),
    0,
  )
  if (count < 1) throw new Error("Cannot resume HITL: no pending actions found.")
  return count
}

function pendingHitlFromTask(task) {
  const pending = task?.status?.message?.metadata?.[HITL_METADATA_KEY]
  if (!Number.isInteger(pending?.actionCount) || pending.actionCount < 1) return undefined
  if (!Array.isArray(pending.decisions)) return undefined
  return pending
}

function pendingActionRequests(task, pending) {
  return (
    pending?.actionRequests || firstDataPart(task?.status?.message?.parts)?.actionRequests || []
  )
}

function interruptDescriptionFromTask(task, pending) {
  const action = pendingActionRequests(task, pending)[pending?.decisions?.length || 0]
  if (action) return action.description || `Approve action: ${action.name}?`
  return (
    task?.status?.message?.parts?.find((part) => part.kind === "text")?.text ||
    "This action requires your approval. Reply 'approve' or 'reject'."
  )
}

function publishInputRequired({ requestContext, eventBus, description, interruptData, pending }) {
  const { taskId, contextId } = requestContext
  eventBus.publish({
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state: "input-required",
      message: agentMessage(description, interruptData, {
        [HITL_METADATA_KEY]: pending,
        [INPUT_REQUIRED_METADATA_KEY]: { options: approvalOptions() },
      }),
      timestamp: new Date().toISOString(),
    },
    final: true,
  })
  eventBus.finished()
}

export function isTimeoutHitl(task) {
  return task?.status?.message?.metadata?.[TIMEOUT_HITL_METADATA_KEY] === true
}

export function publishTimeoutHitl({ requestContext, eventBus, description, serviceName }) {
  const { taskId, contextId } = requestContext
  LOG.info("timeout awaiting decision", { conversation: short(contextId), service: serviceName })
  audit("AgentInputRequired", {
    data: { taskId, contextId, service: serviceName, reason: "timeout", description },
  })
  eventBus.publish({
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state: "input-required",
      message: agentMessage(description, undefined, {
        [TIMEOUT_HITL_METADATA_KEY]: true,
        [INPUT_REQUIRED_METADATA_KEY]: { options: timeoutOptions() },
      }),
      timestamp: new Date().toISOString(),
    },
    final: true,
  })
}

export async function resumeTimeoutHitl({ requestContext, eventBus, stream, signal }) {
  const { taskId, contextId } = requestContext
  const decision = partsToText(requestContext.userMessage?.parts).trim()
  if (!decision) throw new Error(cds.i18n.messages.at("RESUME_REQUIRES_TEXT"))

  if (/^(continue|approve|yes|confirm|ok)$/i.test(decision)) {
    LOG.info("timeout continuation approved", { conversation: short(contextId) })
    audit("AgentTaskResumed", {
      data: { taskId, contextId, service: cds.context?.["agent.service"], reason: "timeout" },
    })
    const resumed = await stream(null, signal)
    return resumed.state
  }

  LOG.info("timeout continuation declined", { conversation: short(contextId) })
  audit("AgentTaskCanceled", {
    data: { taskId, contextId, service: cds.context?.["agent.service"], reason: "timeout" },
  })
  eventBus.publish({
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state: "canceled",
      message: agentMessage("Task stopped by user after timeout."),
      timestamp: new Date().toISOString(),
    },
    final: true,
  })
  return undefined
}

export async function resumeHitl({ requestContext, graph, config, eventBus, stream, signal }) {
  const { taskId, contextId } = requestContext
  const dataPart = firstDataPart(requestContext.userMessage?.parts)
  const userText = partsToText(requestContext.userMessage?.parts)
  if (dataPart === undefined && !userText.trim()) {
    throw new Error(cds.i18n.messages.at("RESUME_REQUIRES_TEXT"))
  }
  const { Command } = await import("@langchain/langgraph")
  let resume = dataPart !== undefined ? dataPart : parseResumeDecision(userText)
  let actionRequests = []

  if (Array.isArray(resume?.decisions)) {
    const pending = pendingHitlFromTask(requestContext.task)
    const actionCount = pending?.actionCount ?? (await getPendingHitlActionCount(graph, config))
    actionRequests = pendingActionRequests(requestContext.task, pending)
    const decisions = [...(pending?.decisions || []), ...resume.decisions]
    if (decisions.length < actionCount) {
      const interruptData = firstDataPart(requestContext.task?.status?.message?.parts)
      const nextPending = { ...pending, actionCount, decisions }
      publishInputRequired({
        requestContext,
        eventBus,
        description: interruptDescriptionFromTask(requestContext.task, nextPending),
        interruptData,
        pending: {
          actionCount,
          decisions,
          actionRequests: pendingActionRequests(requestContext.task, nextPending),
        },
      })
      return undefined
    }
    resume = { ...resume, decisions }
  }

  const decisions = decisionsForAudit(resume, actionRequests)
  LOG.debug("resuming", { conversation: short(contextId), decisions })
  audit("AgentTaskResumed", {
    data: { taskId, contextId, service: cds.context?.["agent.service"], decisions },
  })

  const originalActions = actionRequests.length
    ? actionRequests
    : await getPreInterruptToolCalls(graph, config)
  const decisionNote = composeHitlDecisionNote(originalActions, resume)
  const commandArgs = { resume }
  if (decisionNote) commandArgs.update = { _hitlDecisionNote: decisionNote }
  const resumed = await stream(new Command(commandArgs), signal)
  return resumed.state
}

export function handleHitlInterrupt({
  result,
  requestContext,
  eventBus,
  serviceName,
  duration,
  onInputRequired,
}) {
  const { taskId, contextId } = requestContext
  const description = extractInterruptDescription(result)
  const interruptData = extractInterruptData(result)
  LOG.info("input-required", { conversation: short(contextId), service: serviceName, duration })
  onInputRequired?.(description)
  audit("AgentInputRequired", {
    data: { taskId, contextId, service: serviceName, description, interruptData },
  })
  publishInputRequired({
    requestContext,
    eventBus,
    description,
    interruptData,
    pending: {
      actionCount: interruptActionCount(result),
      decisions: [],
      actionRequests: interruptData?.actionRequests || interruptActionRequests(result),
    },
  })
  return true
}
