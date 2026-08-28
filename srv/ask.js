// srv/ask.js — srv.ask(query, opts?) installed on every @agent service.
// Returns { text, query, traceId, toolCalls, messages }.

import cds from "@sap/cds"
import { attachCqn } from "./tool-calls.js"

export const COLLECT_RESULT = Symbol.for("@cap-js/agents:ask:collect-result")

class NoopEventBus {
  constructor() {
    this.events = []
    this[COLLECT_RESULT] = true
    this._graphResult = null
    this._done = false
    this.finished$ = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
  }

  publish(event) {
    this.events.push(event)
  }

  finished() {
    this._done = true
    this._resolve?.()
  }

  error(err) {
    this._reject?.(err)
  }

  getFinalText() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]
      if (e.kind === "artifact-update" && e.lastChunk === true) {
        const text = e.artifact?.parts
          ?.filter((p) => p.kind === "text")
          .map((p) => p.text)
          .join("")
        if (text) return text
      }
    }
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]
      if (e.kind === "status-update" && e.status?.message?.parts) {
        const text = e.status.message.parts
          .filter((p) => p.kind === "text")
          .map((p) => p.text)
          .join("")
        if (text) return text
      }
    }
    return ""
  }

  getError() {
    for (const e of this.events) {
      if (e.kind === "status-update") {
        const state = e.status?.state
        const msg = e.status?.message?.parts?.find((p) => p.kind === "text")?.text
        if (state === "failed") return new Error(`agent.ask: task failed — ${msg || "no message"}`)
        if (state === "input-required")
          return new Error(`agent.ask: task requires human input (HITL) — ${msg || ""}`)
      }
    }
    return null
  }
}

// Derive toolCalls from graph messages by pairing AIMessage.tool_calls with ToolMessage results.
function toolCallsFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return []

  const resultById = new Map()
  for (const msg of messages) {
    if (msg.tool_call_id && msg.type === "tool") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
      resultById.set(msg.tool_call_id, content)
    }
  }

  const entries = []
  for (const msg of messages) {
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue
    for (const tc of msg.tool_calls) {
      const raw = resultById.get(tc.id)
      let toolResult
      try {
        toolResult = raw !== undefined ? JSON.parse(raw) : undefined
      } catch {
        toolResult = raw
      }
      const entry = {
        tool: tc.name,
        args: tc.args ?? {},
        outcome: "success",
        ...(toolResult !== undefined && { result: toolResult }),
      }
      attachCqn(entry)
      entries.push(entry)
    }
  }
  return entries
}

const _otel = { _api: null, _loaded: false }
async function loadOtel() {
  if (_otel._loaded) return
  _otel._loaded = true
  try {
    _otel._api = await import("@opentelemetry/api")
  } catch {
    /* not present */
  }
}
function readTraceId() {
  try {
    return _otel._api?.trace?.getActiveSpan?.()?.spanContext?.()?.traceId
  } catch {
    return undefined
  }
}

function buildRequestContext(query, opts = {}) {
  const taskId = opts.taskId || cds.utils.uuid()
  const contextId = opts.contextId || cds.utils.uuid()
  const parts =
    opts.parts ??
    (typeof query === "string"
      ? [{ kind: "text", text: query }]
      : (query?.parts ?? [{ kind: "text", text: String(query) }]))
  return {
    taskId,
    contextId,
    task: opts.task ?? null,
    userMessage: {
      kind: "message",
      messageId: cds.utils.uuid(),
      role: "user",
      taskId,
      contextId,
      parts,
    },
  }
}

/** Install srv.ask(query, opts?) on an @agent service. Called from cds.on("serving"). */
export function registerAsk(srv) {
  srv.ask = async function ask(query, opts = {}) {
    await loadOtel()

    const { LangGraphExecutor } = await import("./langgraph-executor-srv.js")
    const executor = LangGraphExecutor.for(srv)
    const requestContext = buildRequestContext(query, opts)
    const eventBus = new NoopEventBus()
    const evalRunId = cds.context?.["agent.eval.runId"]

    const runInContext = async () => {
      if (evalRunId && cds.context) cds.context["_mlflow.evalRunId"] = evalRunId

      let execError = null
      const execPromise = executor.execute(requestContext, eventBus).catch((err) => {
        execError = err
        if (!eventBus._done) eventBus.finished()
      })
      await Promise.race([eventBus.finished$, execPromise])
      if (!eventBus._done) eventBus.finished()
      if (execError) throw execError
    }

    if (cds.context) {
      await runInContext()
    } else {
      await cds._with(
        new cds.EventContext({ tenant: "t0", user: new cds.User.Privileged() }),
        runInContext,
      )
    }

    const err = eventBus.getError()
    if (err) throw err

    const text = eventBus.getFinalText()
    const traceId = readTraceId()
    const messages = eventBus._graphResult?.messages ?? []
    const toolCalls = toolCallsFromMessages(messages)

    return { text, query: String(query), traceId, toolCalls, messages }
  }
}
