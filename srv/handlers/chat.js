import cds from "@sap/cds"
import { startCollection } from "../../lib/eval/span-collector.js"
import { metricsFromSpans } from "../../lib/eval/metrics.js"
import { getActiveRunState, logMlflowMetricsForResult } from "../../lib/eval/eval-run.js"

export const COLLECT_RESULT = Symbol.for("@cap-js/agents:chat:collect-result")

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

/**
 * If entry.args.cql attaches cqn as hidden property.
 * No-op when cql is absent or faulty.
 */
function attachCqn(entry) {
  const cql = entry.args?.cql
  if (typeof cql !== "string") return
  try {
    const cqn = cds.parse.cql(cql)
    Object.defineProperty(entry, "cqn", {
      value: cqn,
      enumerable: false,
      writable: false,
      configurable: true,
    })
  } catch {
    /* unparseable CQL — skip */
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

/** Install srv.chat(query, previous?) on an @agent service for eval tests. */
export function registerChat(srv) {
  srv.chat = async function chat(query, previous) {
    // Resolve the small eval helper API:
    //   chat(query)
    //   chat(query, prevResult) — extract contextId + taskId for HITL resume
    //   chat(query, { _details: true }) — internal/test escape hatch outside test profile
    let opts = {}
    if (typeof previous === "string") {
      throw new TypeError(
        "agent.chat: second argument must be a previous chat result object or options object",
      )
    } else if (previous && typeof previous === "object") {
      if ("text" in previous || "contextId" in previous) {
        // prior chat() result — extract conversation ids and HITL state
        opts = {
          contextId: previous.contextId,
          // mark as resume when prior result was input-required
          ...(previous.status === "input-required" && {
            taskId: previous.taskId,
            task: { id: previous.taskId, status: { state: "input-required" } },
          }),
        }
      } else {
        opts = { _details: previous._details === true }
      }
    }

    const includeDetails = shouldIncludeChatDetails(opts)
    const runState = includeDetails ? getActiveRunState() : null

    // Open span collection session before execution so the processor
    // captures all spans from this trace.
    const collection = includeDetails ? await startCollection() : null

    const { LangGraphExecutor } = await import("../langgraph-executor-srv.js")
    const executor = LangGraphExecutor.for(srv)
    const requestContext = buildRequestContext(query, opts)
    const eventBus = new NoopEventBus()
    const mlflowRunId = runState?.mlflowRunId
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

      if (includeDetails) {
        const rootSpan = cds.context?.["_mlflow.rootSpan"]
        if (rootSpan) traceId = rootSpan.spanContext?.()?.traceId
      }
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
      throw new Error(`agent.chat: task failed — ${description || "no message"}`)

    const text = eventBus.getFinalText()
    const result = {
      text,
      contextId: requestContext.contextId,
      taskId: requestContext.taskId,
      status,
    }

    if (includeDetails) {
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

      const allSpans = collection.collect()
      const spans = traceId
        ? allSpans.filter((s) => s.spanContext?.()?.traceId === traceId)
        : allSpans

      result.query = String(query)
      result.traceId = traceId
      result.toolCalls = toolCalls
      result.messages = messages.map((m) => {
        // Eval prompts expect text content, not content-block objects.
        if (m.type === "ai") {
          if (Array.isArray(m.content) && m.content[0]?.text) {
            m.content = m.content[0].text
          }
        }
        return m
      })
      result.spans = spans
      result.metrics = metricsFromSpans(spans)
      if (runState) result._evalState = runState
      // Post metrics to MLflow ootb — fire-and-forget.
      logMlflowMetricsForResult(result, runState).catch(() => {})
    }

    return result
  }
}

export function shouldIncludeChatDetails(opts = {}) {
  return cds.env.profiles?.includes("test") || opts._details === true
}
