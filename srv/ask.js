import cds from "@sap/cds"
import { attachCqn } from "./tool-calls.js"
import { startCollection } from "../lib/testing/span-collector.js"
import { metricsFromSpans } from "../lib/testing/metrics.js"
import { getActiveRunState, logMlflowMetricsForResult } from "../lib/testing/eval-run.js"

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

  getStatus() {
    const e = this.events.at(-1)
    if (e && e.kind === "status-update" && e.status?.state) {
      const state = e.status.state
      const msg = e.status?.message?.parts?.find((p) => p.kind === "text")?.text ?? ""
      return { status: state, description: msg }
    }
    return { status: "completed", description: "" }
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

/** Install srv.ask(query, contextId?, opts?) on an @agent service. Called from cds.on("serving"). */
export function registerAsk(srv) {
  srv.ask = async function ask(query, second, third) {
    // Resolve opts from flexible overloads:
    //   ask(query)
    //   ask(query, contextId)         — string
    //   ask(query, prevResult)        — result object → extract contextId + taskId (HITL resume)
    //   ask(query, opts)              — plain opts object
    //   ask(query, contextId, opts)   — string + opts object
    let opts = {}
    if (typeof second === "string") {
      opts = { contextId: second, ...third }
    } else if (second && typeof second === "object") {
      if ("text" in second || "contextId" in second) {
        // prior ask() result — extract conversation ids and HITL state
        opts = {
          contextId: second.contextId,
          // mark as resume when prior result was input-required
          ...(second.status === "input-required" && {
            taskId: second.taskId,
            task: { id: second.taskId, status: { state: "input-required" } },
          }),
          ...(typeof third === "object" ? third : {}),
        }
      } else {
        opts = second
      }
    }

    const runState = getActiveRunState()

    // Open span collection session before execution so the processor
    // captures all spans from this trace.
    const collection = await startCollection()

    const { LangGraphExecutor } = await import("./langgraph-executor-srv.js")
    const executor = LangGraphExecutor.for(srv)
    const requestContext = buildRequestContext(query, opts)
    const eventBus = new NoopEventBus()
    const mlflowRunId = runState?.mlflowRunId
    const t0 = Date.now()
    let traceId

    const runInContext = async () => {
      // Link the trace to the MLflow eval run — graph-executor reads this to set mlflow.sourceRun.
      if (mlflowRunId && cds.context) cds.context["_mlflow.evalRunId"] = mlflowRunId

      let execError = null
      const execPromise = executor.execute(requestContext, eventBus).catch((err) => {
        execError = err
        if (!eventBus._done) eventBus.finished()
      })
      await Promise.race([eventBus.finished$, execPromise])
      if (!eventBus._done) eventBus.finished()
      if (execError) throw execError

      const rootSpan = cds.context?.["_mlflow.rootSpan"]
      if (rootSpan) traceId = rootSpan.spanContext?.()?.traceId
    }

    if (cds.context) {
      await runInContext()
    } else {
      await cds._with(
        new cds.EventContext({ tenant: "t0", user: new cds.User.Privileged() }),
        runInContext,
      )
    }

    const { status, description } = eventBus.getStatus()
    if (status === "failed")
      throw new Error(`agent.ask: task failed — ${description || "no message"}`)

    const text = eventBus.getFinalText()
    const allMessages = eventBus._graphResult?.messages ?? []

    // Find last HumanMessage whose text matches current query; return from there.
    const queryText = String(query)
    let turnStart = 0
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i]
      if (m.getType?.() === "human" || m._getType?.() === "human" || m.type === "human") {
        const content = typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "")
        if (content.startsWith(queryText) || queryText.startsWith(content.trim())) {
          turnStart = i
          break
        }
      }
    }
    const messages = allMessages.slice(turnStart)
    const toolCalls = toolCallsFromMessages(messages)
    const latencyMs = Date.now() - t0

    const allSpans = collection.collect()
    const spans = traceId
      ? allSpans.filter((s) => s.spanContext?.()?.traceId === traceId)
      : allSpans
    const result = {
      text,
      query: String(query),
      contextId: requestContext.contextId,
      taskId: requestContext.taskId,
      traceId,
      toolCalls,
      messages: messages.map((m) => {
        // Needed for Agent Trajectory. content is expected to be a string, else object object is written into the prompt
        if (m.type === "ai") {
          if (Array.isArray(m.content) && m.content[0]?.text) {
            m.content = m.content[0].text
          }
        }
        return m
      }),
      spans,
      latencyMs,
      status,
      description,
    }

    result.metrics = metricsFromSpans(spans, latencyMs)
    if (runState) result._evalState = runState

    // Post metrics to MLflow ootb — fire-and-forget.
    logMlflowMetricsForResult(result, runState).catch(() => {})

    return result
  }
}
