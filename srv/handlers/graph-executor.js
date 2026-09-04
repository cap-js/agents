import cds from "@sap/cds"
import { short, audit, ms4 } from "../../lib/utils/utils.js"
import { partsToText, buildChatMessages, firstDataPart } from "../../lib/utils/message-handling.js"
import * as metrics from "../../lib/telemetry/metrics.js"
import { mlflowAttrs, mlflowTraceAttrs, setSpanAttrs } from "../../lib/telemetry/mlflow/index.js"
import { CdsFileStore } from "../../lib/protocol/persistence/file-store.js"
import { formatFileSize, sanitizeFilename } from "./tools.js"
import { convertUsageData } from "../../lib/telemetry/chat-tracing.js"
import { triggerCleanup } from "../../lib/protocol/persistence/cleanup.js"
import { COLLECT_RESULT } from "./chat.js"
import { linkTraceToPrompt } from "../../lib/telemetry/mlflow/tracing.js"

const LOG = cds.log("agents")

/**
 * Validate against the configured cap and MIME allowlist
 */
function checkInputFile(file, cfg) {
  const maxBytes = cfg?.maxInputFileSizeBytes
  if (maxBytes > 0 && typeof file?.bytes === "string") {
    const declared = Buffer.byteLength(file.bytes, "base64")
    if (declared > maxBytes) {
      return `exceeds size limit (${formatFileSize(declared)} > ${formatFileSize(maxBytes)})`
    }
  }
  const allowed = cfg?.defaultInputModes
  if (Array.isArray(allowed) && allowed.length > 0) {
    const mime = file?.mimeType || "application/octet-stream"
    if (!allowed.includes(mime)) {
      return `mime type ${mime} not allowed`
    }
  }
  return null
}

/**
 * Thrown when a task execution is aborted (client disconnect or tasks/cancel).
 */
class AbortError extends Error {
  constructor(message) {
    super(message)
    this.name = "AbortError"
    this.code = "ABORT_ERR"
  }
}

/**
 * Thrown when graph execution exceeds the configured timeout.
 * Carries partial state for graceful summarization.
 */
class TimeoutError extends Error {
  constructor(message, { timeout } = {}) {
    super(message)
    this.name = "TimeoutError"
    this.code = "TIMEOUT_ERR"
    this.timeout = timeout
  }
}

/**
 * Default input mapper: extracts text from A2A message parts and wraps as HumanMessage.
 *
 * NOTE TO CUSTOM INPUTMAPPER AUTHORS: when fileIO is enabled and you replace
 * this mapper, copy the `_fileManifest` handling below or files will be silently
 * persisted but invisible to the model.
 */
async function defaultInputMapper(requestContext) {
  const { HumanMessage } = await import("@langchain/core/messages")
  const text = partsToText(requestContext.userMessage?.parts)
  const fullText = requestContext._fileManifest ? `${text}\n${requestContext._fileManifest}` : text
  return { messages: [new HumanMessage(fullText)] }
}

/**
 * Extract plain text from a LangChain message's `content`, which may be a string
 * or an array of content blocks (`[{ type: "text", text }, ...]`). Non-text
 * blocks (tool_call, reasoning, …) are dropped.
 */
function messageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("")
  }
  return ""
}

/**
 * Default output mapper: extracts response text from graph result.
 * Priority: last AI message content > result.output > JSON stringified result.
 */
function defaultOutputMapper(result) {
  // 1. Messages-based: last message content (standard LangChain pattern)
  if (result.messages?.length > 0) {
    const lastMsg = result.messages[result.messages.length - 1]
    const text = messageText(lastMsg?.content)
    if (text) return text
  }
  // 2. Output field (e.g. travel-sample pattern)
  if (result.output) return result.output
  // 3. Fallback
  return JSON.stringify(result)
}

// Construct a spec-compliant A2A Message; when `data` is a plain object, append it as a DataPart.
function agentMessage(text, data) {
  const parts = [{ kind: "text", text }]
  if (data && typeof data === "object") parts.push({ kind: "data", data })
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts,
  }
}

/**
 * Extract user text from A2A message parts.
 */
function extractText(requestContext) {
  return partsToText(requestContext.userMessage?.parts)
}

// Extract the first inbound DataPart's opaque `data` object, or undefined if none.
function extractData(requestContext) {
  return firstDataPart(requestContext.userMessage?.parts)
}

/**
 * Parse user's resume text into a HITL decision.
 * Maps to the format expected by deepagents' humanInTheLoopMiddleware.
 */
function parseResumeDecision(userText) {
  const t = userText.trim()
  if (/^(approve|yes|confirm|ok)$/i.test(t)) {
    return { decisions: [{ type: "approve" }] }
  }
  if (/^edit$/i.test(t)) {
    // Bare edit — structured edits (with args) arrive via the DataPart path.
    return { decisions: [{ type: "edit" }] }
  }
  return { decisions: [{ type: "reject", message: userText }] }
}

// Best-effort decision label for logging/audit; opaque DataPart resumes fall back to "data".
function decisionTypeOf(resume) {
  return resume?.decisions?.[0]?.type ?? "data"
}

/**
 * Extract the human-readable description from an interrupt payload.
 * Accepts either a graph result (with __interrupt__) or a GraphInterrupt error (with .interrupts).
 * Handles both deepagents' humanInTheLoopMiddleware format and raw interrupt() calls.
 */
function extractInterruptDescription(resultOrErr) {
  const interrupt = resultOrErr.__interrupt__?.[0] || resultOrErr.interrupts?.[0]
  const payload = interrupt?.value
  if (!payload) return "This action requires your approval. Reply 'approve' or 'reject'."

  // deepagents' humanInTheLoopMiddleware: { actionRequests: [{ description }], reviewConfigs }
  if (payload.actionRequests?.length > 0) {
    return (
      payload.actionRequests[0].description || `Approve action: ${payload.actionRequests[0].name}?`
    )
  }

  // Raw interrupt(value) - value is a string or object
  if (typeof payload === "string") return payload
  return JSON.stringify(payload)
}

/**
 * Extract the raw structured interrupt payload for opaque carry on a DataPart.
 * Returns the payload ONLY when it is a plain object; arrays and strings are
 * carried by the TextPart alone. Payload is app-defined; the plugin never
 * interprets it.
 */
function extractInterruptData(resultOrErr) {
  const interrupt = resultOrErr.__interrupt__?.[0] || resultOrErr.interrupts?.[0]
  const payload = interrupt?.value
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
  return payload
}

// Order-invariant JSON serializer for structural arg comparison.
function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]"
  const keys = Object.keys(value).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}"
}

// Firm note describing HITL edits so the model doesn't apologize on the next turn.
function composeEditNote(originals, resume) {
  const decisions = resume?.decisions
  if (!Array.isArray(decisions) || decisions.length === 0) return undefined

  const consumed = new Set()
  const takeByName = (name) => {
    for (let j = 0; j < originals.length; j++) {
      if (!consumed.has(j) && originals[j]?.name === name) {
        consumed.add(j)
        return originals[j]
      }
    }
    return undefined
  }
  const takeNextUnconsumed = () => {
    for (let j = 0; j < originals.length; j++) {
      if (!consumed.has(j)) {
        consumed.add(j)
        return originals[j]
      }
    }
    return undefined
  }

  const changes = []
  for (const d of decisions) {
    if (d?.type !== "edit" || !d.editedAction) continue
    const editedName = d.editedAction.name
    const editedArgs = d.editedAction.args
    const orig = takeByName(editedName) ?? takeNextUnconsumed()
    if (!orig) continue
    if (orig.name === editedName && canonicalJSON(orig.args) === canonicalJSON(editedArgs)) continue
    changes.push({
      from: { name: orig.name, args: orig.args },
      to: { name: editedName, args: editedArgs },
    })
  }
  if (changes.length === 0) return undefined

  const lines = changes.map(
    (c) =>
      `- \`${c.from.name}(${JSON.stringify(c.from.args)})\` → \`${c.to.name}(${JSON.stringify(c.to.args)})\``,
  )
  return [
    "The user reviewed your proposed tool call(s) in the human-in-the-loop approval flow and edited them before execution. This is intentional user action, NOT a mistake on your part. Do NOT apologize or say you made an error.",
    "",
    "Edits applied:",
    ...lines,
    "",
    "Proceed as if the edited values are what the user actually wants. Describe the outcome of the executed call accurately.",
  ].join("\n")
}

// Reads the pre-interrupt AI's tool_calls from the checkpointer (still un-mutated at resume time).
async function getPreInterruptToolCalls(graph, config) {
  try {
    if (typeof graph.getState !== "function") return []
    const state = await graph.getState(config)
    const messages = state?.values?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.tool_calls?.length) {
        return m.tool_calls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }))
      }
    }
    return []
  } catch {
    return []
  }
}

/**
 * GraphExecutor wraps a compiled LangGraph graph as an A2A AgentExecutor.
 *
 * Supports:
 * - Single-turn and multi-turn conversations (via auto-injected CdsCheckpointSaver)
 * - HITL (Human-in-the-Loop) via LangGraph's interrupt()/Command resume mechanism
 * - Configurable timeout, input/output mappers
 *
 * Usage:
 * Created by the default `buildGraph` event handler or by apps returning a
 * compiled graph from their custom `buildGraph` handler.
 */
class GraphExecutor {
  constructor(graph, srv, options = {}) {
    this._rawGraph = graph
    this._graph = null
    this._srv = srv
    this._options = options
    this._inputMapper = options.inputMapper || null
    this._outputMapper = options.outputMapper || null
    this._configMapper = options.configMapper || null
    this._recursionLimit = options.recursionLimit ?? null
    /** @type {Map<string, AbortController>} per-task abort controllers */
    this._abortControllers = new Map()
  }

  /**
   * Abort a running task execution. Called on client disconnect or tasks/cancel.
   * Safe to call multiple times or for unknown taskIds.
   */
  abort(taskId) {
    const controller = this._abortControllers.get(taskId)
    if (controller && !controller.signal.aborted) {
      LOG.info("aborting", { task: short(taskId), service: this._srv.name })
      controller.abort()
    }
  }

  async _resolveGraph() {
    if (this._graph) return this._graph
    const resolved = await this._rawGraph
    if (!resolved || typeof resolved.invoke !== "function") {
      throw new Error(
        `buildGraph must return a compiled LangGraph graph (with an invoke() method). Got: ${typeof resolved}`,
      )
    }
    // Auto-inject CdsCheckpointSaver if graph has no checkpointer (enables multi-turn + HITL)
    if (!resolved.checkpointer && this._options?.checkpointer !== false) {
      const { CdsCheckpointSaver } =
        await import("../../lib/protocol/persistence/checkpoint-saver.js")
      resolved.checkpointer = new CdsCheckpointSaver()
      LOG.debug("Auto-injected CdsCheckpointSaver", { service: this._srv.name })
    }
    this._graph = resolved
    return this._graph
  }

  /**
   * Drive the graph with graph.stream() in "messages"+"updates" mode, publishing
   * per-token artifact-update SSE events as LLM tokens arrive.
   */
  async _streamWithPublish(graph, input, config, eventBus, taskId, contextId, signal) {
    const maxExecution = ms4(cds.env.agents?.pool?.maxExecutionTimePerTask || "5min")
    const grace = this._getGrace()
    const softTimeout = Math.max(maxExecution - grace, 1000)

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), softTimeout)
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

    let tokenCount = 0
    let finalState = null
    // Track the current turn (langchain message id) and whether it has emitted a
    // tool call. Anthropic-style turns can stream a text preamble BEFORE their
    // tool_use block ("Let me first look up …"); we can't tell in advance that
    // such a turn is planning rather than the final answer, so we stream those
    // tokens optimistically. Once we see tool_call_chunks for the same turn, we
    // know retrospectively that the preamble was planning — emit an authoritative
    // event-level replace with empty text to wipe the leaked preamble, then skip
    // all further text from this turn.
    let currentMsgId = null
    let turnHasToolCall = false

    try {
      if (typeof graph.stream !== "function" || cds.env.agents?.streaming === false) {
        const state = await this._invokeWithTimeout(graph, input, config, signal)
        return { state, tokenCount: 0 }
      }

      const streamConfig = {
        ...config,
        streamMode: ["messages", "updates"],
        signal: combinedSignal,
      }

      // ReactAgent.stream() and compiled StateGraph.stream() both return an
      // AsyncIterable (ReactAgent wraps in a promise — normalise both).
      const raw = graph.stream(input, streamConfig)
      const iterable = raw && typeof raw[Symbol.asyncIterator] === "function" ? raw : await raw

      for await (const chunk of iterable) {
        // Multi-mode stream yields [mode, payload] tuples
        if (!Array.isArray(chunk) || chunk.length < 2) continue
        const [mode, payload] = chunk

        if (mode === "messages") {
          // payload is [AIMessageChunk, metadata]
          const msgChunk = Array.isArray(payload) ? payload[0] : payload
          const meta = Array.isArray(payload) ? payload[1] : undefined
          if (msgChunk?.type !== "ai") continue
          // Skip tokens from NESTED model calls (pipe is used as separator by langchain)
          if (meta?.langgraph_checkpoint_ns?.includes("|")) continue
          // Only stream tokens from the main agent model call.
          if (meta?.langgraph_node && meta.langgraph_node !== "model_request") continue

          if (msgChunk.id && msgChunk.id !== currentMsgId) {
            currentMsgId = msgChunk.id
            turnHasToolCall = false
            tokenCount = 0
          }

          // Retroactively invalidate a leaked planning preamble. In a ReAct loop
          // the model can emit "Let me look this up …" before its tool_use block
          if (msgChunk.tool_call_chunks?.length && !turnHasToolCall) {
            turnHasToolCall = true
            if (tokenCount > 0) {
              eventBus.publish({
                kind: "artifact-update",
                taskId,
                contextId,
                append: false,
                lastChunk: false,
                artifact: {
                  artifactId: "response",
                  parts: [{ kind: "text", text: "" }],
                },
              })
              tokenCount = 0
            }
          }
          if (turnHasToolCall) continue

          const text = messageText(msgChunk?.content)
          if (!text) continue
          // A2A TaskArtifactUpdateEvent: `append` and `lastChunk` are event-level
          // fields (siblings of `artifact`), NOT properties of `artifact`. The SDK's
          // ResultManager reads event.append; nesting them leaves it undefined and
          // forces replace-on-every-chunk instead of accumulation.
          eventBus.publish({
            kind: "artifact-update",
            taskId,
            contextId,
            append: tokenCount > 0,
            lastChunk: false,
            artifact: {
              artifactId: "response",
              parts: [{ kind: "text", text }],
            },
          })
          tokenCount++
        } else if (mode === "updates") {
          // The updates stream yields per-node deltas — { <node>: { messages: [oneNewMessage] } },
          // NOT the accumulated conversation. Spreading these would leave finalState
          // with only the last node's single message, losing earlier turns (e.g. the
          // AIMessage carrying an emit_file_part tool_call and its ToolMessage result).
          // We therefore only lift the ephemeral __interrupt__ signal here (HITL) and
          // recover the full, reduced message list from the checkpoint after the stream.
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            if (payload.__interrupt__ !== undefined) {
              finalState = { ...finalState, __interrupt__: payload.__interrupt__ }
            }
          }
        }
      }
    } catch (err) {
      if (combinedSignal.aborted) {
        if (signal?.aborted) {
          throw new AbortError("Task execution aborted")
        }
        throw new TimeoutError(`Graph execution timed out after ${softTimeout / 1000}s`, {
          timeout: softTimeout,
        })
      }
      throw err
    } finally {
      clearTimeout(timeoutHandle)
    }

    // Recover the fully-reduced state from the checkpoint. The streamed updates only
    // carry per-node message deltas, so channel_values is the authoritative source for
    // the complete message list (required by the file-I/O scan below and outputMapper).
    // The __interrupt__ captured from the updates stream is preserved — it is an
    // ephemeral signal that may already be cleared from channel_values.
    if (this._graph?.checkpointer) {
      try {
        const thread_id = config.configurable?.thread_id
        let cp = await this._graph.checkpointer.getTuple({ configurable: { thread_id } })
        if (!cp?.checkpoint?.channel_values && this._graph.checkpointer.latestNamespace) {
          const ns = await this._graph.checkpointer.latestNamespace(thread_id)
          if (ns) {
            cp = await this._graph.checkpointer.getTuple({
              configurable: { thread_id, checkpoint_ns: ns },
            })
          }
        }
        const channelValues = cp?.checkpoint?.channel_values
        if (channelValues) {
          const interrupt = finalState?.__interrupt__
          finalState = {
            ...channelValues,
            ...(interrupt !== undefined && { __interrupt__: interrupt }),
          }
        }
      } catch {
        /* best-effort */
      }
    }

    return { state: finalState, tokenCount }
  }
  /**
   * Parse configured timeout grace period.
   */
  _getGrace() {
    return ms4(cds.env.agents?.pool?.timeoutGrace ?? "15s")
  }

  async _invokeWithTimeout(graph, input, config, signal) {
    const maxExecution = ms4(cds.env.agents?.pool?.maxExecutionTimePerTask || "5min")
    const grace = this._getGrace()
    // Soft timeout fires early to allow graceful summarization
    const softTimeout = Math.max(maxExecution - grace, 1000)

    // Use explicit AbortController + setTimeout (reffed timer keeps event loop alive)
    // instead of AbortSignal.timeout() which uses an unreffed timer
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), softTimeout)

    // Combine caller-provided abort signal with timeout
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    // Pass signal to LangGraph — it checks between node executions
    config.signal = combinedSignal
    try {
      return await graph.invoke(input, config)
    } catch (err) {
      if (combinedSignal.aborted) {
        // Caller abort takes priority (both can be true simultaneously in a race)
        if (signal?.aborted) {
          throw new AbortError("Task execution aborted")
        }
        throw new TimeoutError(`Graph execution timed out after ${softTimeout / 1000}s`, {
          timeout: softTimeout,
        })
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Summarize partial work after forced interruption (timeout, quota, etc.).
   */
  async _summarizePartialWork(taskId, contextId, serviceName, reason) {
    const { summarizePartialWork } = await import("../../lib/agents/summarize-on-timeout.js")
    const grace = this._getGrace()
    return summarizePartialWork({
      taskId,
      contextId,
      serviceName,
      reason,
      checkpointer: this._graph?.checkpointer,
      getModel: () => this._srv.send("buildModel"),
      timeout: Math.max(grace - 2000, grace * 0.8, 500),
    })
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const serviceName = this._srv.name
    const isResume = requestContext.task?.status?.state === "input-required"
    const mAttrs = metrics.attrs(serviceName)

    // Cooperative cancellation: per-task AbortController
    const controller = new AbortController()
    this._abortControllers.set(taskId, controller)

    // A2A context for tracing
    if (!cds.context) {
      throw Error(`Agent ${serviceName} must be called with cds.context in place!`)
    }
    cds.context["agent.task.id"] = taskId
    cds.context["agent.context.id"] = contextId
    cds.context["agent.service"] = serviceName
    cds.context["agent.eventBus"] = eventBus

    metrics.concurrentExecutions.add(1, mAttrs)

    if (!isResume) {
      if (cds.context?.["agent.new.task"]) {
        await INSERT.into("cap.agent.Tasks").entries({
          taskId,
          contextId,
          state: "submitted",
          data: JSON.stringify({
            id: taskId,
            contextId,
            kind: "task",
            status: { state: "submitted", timestamp: new Date().toISOString() },
          }),
          agentService: serviceName,
        })
        delete cds.context["agent.new.task"]
      }

      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
      })

      // Audit: task started
      audit("AgentTaskStarted", {
        data: { taskId, contextId, service: serviceName, userMessage: requestContext.userMessage },
      })
      // Lazy scheduling task deletion
      cds.spawn({}, async () => {
        await triggerCleanup(serviceName)
      })
    }

    // ── File I/O: persist incoming FileParts to cap.agent.Tasks.inputFiles ──
    // Build a manifest string so the LLM sees /uploads/<name> paths, not raw bytes.
    const fileStore = cds.env.agents?.fileIO?.enabled ? new CdsFileStore() : null
    if (fileStore && !isResume) {
      const fileParts = requestContext.userMessage?.parts?.filter((p) => p.kind === "file") || []
      const manifestLines = await Promise.all(
        fileParts.map(async (fp) => {
          const file = fp.file || fp
          if (file.bytes) {
            try {
              // Sanitize: strips path components and unsafe characters so the name
              // is a stable DB key, /uploads/ path fragment, and artifactId.
              const safeName = sanitizeFilename(file.name)
              const safeMime = file.mimeType || "application/octet-stream"
              // Pre-decode guard: reject oversized or disallowed-mime uploads
              // before allocating a Buffer for the base64 payload.
              const rejection = checkInputFile(
                { ...file, mimeType: safeMime },
                cds.env.agents?.fileIO,
              )
              if (rejection) {
                LOG.warn("input file rejected", {
                  conversation: short(contextId),
                  service: serviceName,
                  name: safeName,
                  mimeType: safeMime,
                  reason: rejection,
                })
                return `/uploads/${safeName} (rejected: ${rejection})`
              }
              const buf = Buffer.from(file.bytes, "base64")
              await fileStore.saveInputFile(taskId, safeName, safeMime, buf)
              LOG.info("file uploaded", {
                conversation: short(contextId),
                service: serviceName,
                name: safeName,
                mimeType: safeMime,
                size: buf.length,
              })
              return `/uploads/${safeName} (${safeMime}, ${formatFileSize(buf.length)})`
            } catch (err) {
              LOG.error("Failed to persist uploaded file", { name: file.name, error: err.message })
              return `/uploads/${sanitizeFilename(file.name)} (persist failed: ${err.message})`
            }
          } else if (file.uri) {
            return `${file.uri} (${file.mimeType || "unknown"}, URI reference)`
          }
          return null
        }),
      )
      const validLines = manifestLines.filter(Boolean)
      if (validLines.length) {
        requestContext._fileManifest = `[Uploaded files: ${validLines.join(", ")}]`
      }
    }

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    })

    const tracer = metrics.getTracer()
    const runWorkflow = async (wfSpan) => {
      if (wfSpan) {
        wfSpan.setAttribute("gen_ai.operation.name", "invoke_agent")
        wfSpan.setAttribute("gen_ai.agent.name", serviceName)
        wfSpan.setAttribute("agent.task.id", taskId)
        wfSpan.setAttribute("agent.context.id", contextId)
        wfSpan.setAttribute("agent.service", serviceName)
        // MLflow: workflow span carries AGENT type + inputs for the
        // span-detail view
        wfSpan.setAttribute("mlflow.message.format", "langchain-js")
        setSpanAttrs(
          wfSpan,
          mlflowAttrs("AGENT", {
            inputs: { messages: buildChatMessages(requestContext) },
            functionName: serviceName,
          }),
        )
        const rootSpan = cds.context["_mlflow.rootSpan"]
        rootSpan.setAttribute("agent.task.id", cds.context["agent.task.id"])
        rootSpan.setAttribute("agent.context.id", cds.context["agent.context.id"])
        rootSpan.setAttribute("agent.service", cds.context["agent.service"])
        // MLflow: trace correlation on the OTel root span.
        // - mlflow.spanInputs → Request column in the trace list
        // - session.id / user.id / mlflow.traceTag.* (via mlflowTraceAttrs) → session
        //   and tag columns in the trace list.
        const userText = extractText(requestContext)
        setSpanAttrs(
          rootSpan,
          mlflowAttrs("CHAIN", {
            // In case rootSpan is HTTP keep its name, if no name yet given fallback to service
            functionName: rootSpan.name ?? serviceName,
            inputs:
              userText !== undefined
                ? { messages: [{ role: "user", content: userText }] }
                : undefined,
          }),
        )
        setSpanAttrs(rootSpan, mlflowTraceAttrs())
        // Required for MLFLow run linking
        const evalRunId = cds.context?.["_mlflow.evalRunId"]
        if (evalRunId) {
          rootSpan.setAttribute("mlflow.sourceRun", evalRunId)
          wfSpan.setAttribute("mlflow.sourceRun", evalRunId)
        }
      }

      let usageData
      let result
      try {
        const graph = await this._resolveGraph()

        const extraConfig = this._configMapper ? await this._configMapper(requestContext) : {}
        if (extraConfig !== null && extraConfig !== undefined && typeof extraConfig !== "object") {
          throw new TypeError(`configMapper must return a plain object, got ${typeof extraConfig}`)
        }
        const config = {
          // Prefer limit at construction time, then cds.env then defaults (standard langchain -> 25, deepagent -> 10_000).
          recursionLimit: this._recursionLimit || cds.env.agents.recursionLimit || undefined,
          configurable: {
            ...extraConfig,
            thread_id: `${serviceName}:${contextId}`,
            _taskId: taskId,
            _service: serviceName,
            // Captured at request entry — backends/tools running inside graph
            // callbacks should prefer this over cds.context, which can drift to
            // "anonymous" across AsyncLocalStorage boundaries.
            _userId: cds.context?.user?.id,
          },
        }

        const t0 = Date.now()

        if (isResume) {
          const dataPart = extractData(requestContext)
          const userText = extractText(requestContext)
          // Relaxed guard: accept a DataPart-only resume OR non-empty text.
          if (dataPart === undefined && !userText.trim()) {
            throw new Error(cds.i18n.messages.at("RESUME_REQUIRES_TEXT"))
          }
          const { Command } = await import("@langchain/langgraph")
          // DataPart wins over text — a structured resume is self-describing and any
          // accompanying text is treated as incidental (e.g. a human-readable echo).
          const resume = dataPart !== undefined ? dataPart : parseResumeDecision(userText)
          const decision = decisionTypeOf(resume)

          LOG.debug("resuming", {
            conversation: short(contextId),
            service: serviceName,
            decision,
          })

          // Audit: task resumed with HITL decision
          audit("AgentTaskResumed", {
            data: {
              taskId,
              contextId,
              service: serviceName,
              decision,
            },
          })
          // On edit, stash a diff note in state; the injector middleware prepends it next turn.
          const commandArgs = { resume }
          if (decision === "edit") {
            const originals = await getPreInterruptToolCalls(graph, config)
            const editNote = composeEditNote(originals, resume)
            if (editNote) commandArgs.update = { _hitlEditNote: editNote }
          }
          const resumed = await this._streamWithPublish(
            graph,
            new Command(commandArgs),
            config,
            eventBus,
            taskId,
            contextId,
            controller.signal,
          )
          result = resumed.state
        } else {
          const inputMapper = this._inputMapper || defaultInputMapper
          const rawInput = await inputMapper(requestContext)
          const { _toolMapOverride, ...input } = rawInput
          if (_toolMapOverride) config.configurable._toolMapOverride = _toolMapOverride
          const streamed = await this._streamWithPublish(
            graph,
            input,
            config,
            eventBus,
            taskId,
            contextId,
            controller.signal,
          )
          result = streamed.state
        }
        // Capture result for usage tracking in finally block
        // (interrupt-only results may have no `messages` — treat as empty)
        usageData = aggregateUsageData(result.messages || [])

        if (result?.__interrupt__?.length > 0) {
          const description = extractInterruptDescription(result)
          const interruptData = extractInterruptData(result)

          const duration = ((Date.now() - t0) / 1000).toFixed(1) + "s"
          LOG.info("input-required", {
            conversation: short(contextId),
            service: serviceName,
            duration,
          })

          if (wfSpan) {
            wfSpan.setAttribute("agent.outcome", "input-required")
            const outputs = {
              choices: [{ message: { role: "assistant", content: description } }],
            }
            setSpanAttrs(wfSpan, mlflowAttrs("AGENT", { outputs }))
            const rootSpan = cds.context?.["_mlflow.rootSpan"]
            if (rootSpan) {
              setSpanAttrs(rootSpan, mlflowAttrs("CHAIN", { outputs }))
            }
          }

          // Audit: agent requires human input
          audit("AgentInputRequired", {
            data: {
              taskId,
              contextId,
              service: serviceName,
              description,
              interruptData,
            },
          })

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state: "input-required",
              message: agentMessage(description, interruptData),
              timestamp: new Date().toISOString(),
            },
            final: true,
          })
          eventBus.finished()
          return
        }

        const duration = ((Date.now() - t0) / 1000).toFixed(1) + "s"
        const outputMapper = this._outputMapper || defaultOutputMapper
        const output = outputMapper(result) || "I could not generate a response."

        LOG.info("completed", { conversation: short(contextId), service: serviceName, duration })

        if (wfSpan) {
          wfSpan.setAttribute("agent.outcome", "completed")
          setSpanAttrs(
            wfSpan,
            mlflowAttrs("AGENT", {
              outputs: { choices: [{ message: { role: "assistant", content: output } }] },
              functionName: serviceName,
            }),
          )
        }
        const rootSpan = cds.context?.["_mlflow.rootSpan"]
        if (rootSpan) {
          setSpanAttrs(
            rootSpan,
            mlflowAttrs("CHAIN", {
              outputs: { choices: [{ message: { role: "assistant", content: output } }] },
            }),
          )
        }

        metrics.workflowsCompleted.add(1, mAttrs)

        // Audit: task completed
        audit("AgentTaskCompleted", {
          data: {
            taskId,
            contextId,
            service: serviceName,
            duration,
            tokenUsage: usageData,
            toolCalls: toolCallsShortened(result.messages),
            task: requestContext.task,
          },
        })

        // Final artifact: authoritative full response text. Emitted as an event-level
        // replace (append:false) so it never doubles the incrementally-streamed tokens
        // and always leaves Task.artifacts with the complete, correct text — for both
        // the streaming path (supersedes accumulated deltas) and the blocking path
        // (the sole emit). lastChunk:true signals the response artifact is complete.
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          append: false,
          lastChunk: true,
          artifact: {
            artifactId: "response",
            parts: [{ kind: "text", text: output }],
          },
        })

        // ── File I/O: collect output files from cap.agent.Tasks.outputFiles ──────
        // Covers two sources:
        //   1. emit_file_part tool calls (default graph) — JSON in toolResults/messages
        //   2. write_file '/outputs/*' via OutputsBackend (deep agent) — CDS rows
        const fileArtifacts = []
        const maxFileBytes = cds.env.agents.fileIO.maxOutputFileSizeBytes

        // Artifacts from emit_file_part are this agent's own outputs — they must be
        // published as A2A FileParts but must NOT be re-persisted as inputFiles
        // (that would make them reappear as /uploads/ entries next turn).
        // ToolMessage.name is not set by the tool node, so derive the tool name
        // by matching tool_call_id against AIMessage.tool_calls[].
        const allMessages = result.messages || []
        const emitFilePartCallIds = new Set()
        for (const msg of allMessages) {
          if (msg.tool_calls?.length > 0) {
            for (const tc of msg.tool_calls) {
              if (tc.name === "emit_file_part") emitFilePartCallIds.add(tc.id)
            }
          }
        }
        for (const msg of allMessages) {
          const isFromEmitFilePart = !!(
            msg.tool_call_id && emitFilePartCallIds.has(msg.tool_call_id)
          )
          const content = typeof msg.content === "string" ? msg.content : ""
          let pos = 0
          while (pos < content.length) {
            const start = content.indexOf('{"kind":"file"', pos)
            if (start === -1) break
            // Walk forward tracking depth and quoted strings so that '}' inside
            // a string value (e.g. a filename like "result_{final}.csv") does not
            // prematurely close the object.
            let depth = 0
            let inString = false
            let i = start
            while (i < content.length) {
              const ch = content[i]
              if (inString) {
                if (ch === "\\") {
                  i += 2 // skip escaped character — cannot be a structural char
                  continue
                }
                if (ch === '"') inString = false
              } else {
                if (ch === '"') inString = true
                else if (ch === "{") depth++
                else if (ch === "}") {
                  depth--
                  if (depth === 0) break
                }
              }
              i++
            }
            const raw = content.slice(start, i + 1)
            try {
              const artifact = JSON.parse(raw)
              // Apply the same per-file size cap as Source 2. Decode-length is
              // computed by Buffer.byteLength (zero allocation — pure formula
              // over string length + padding) so an oversized blob never pins
              // memory just to be discarded.
              const declaredBytes =
                typeof artifact.file?.bytes === "string"
                  ? Buffer.byteLength(artifact.file.bytes, "base64")
                  : 0
              if (declaredBytes > maxFileBytes) {
                LOG.warn("emit_file_part artifact exceeds cap; skipping", {
                  conversation: short(contextId),
                  service: serviceName,
                  name: artifact.file?.name,
                  size: declaredBytes,
                  cap: maxFileBytes,
                })
                pos = i + 1
                continue
              }
              // Tag emit_file_part artifacts so the re-persist step can exclude them.
              // The tag is stripped before publishing so clients never see it.
              if (isFromEmitFilePart) artifact._fromEmitFilePart = true
              fileArtifacts.push(artifact)
            } catch {
              /* not valid JSON — skip */
            }
            pos = i + 1
          }
        }

        // Source 2: output files written by deep agent via /outputs/ path.
        if (fileStore) {
          const source1Count = fileArtifacts.length
          const outputMeta = await fileStore.listOutputFilesMeta(taskId)
          for (const meta of outputMeta) {
            if (meta.size > maxFileBytes) {
              LOG.warn("output file exceeds cap; skipping", {
                conversation: short(contextId),
                service: serviceName,
                name: meta.name,
                size: meta.size,
                cap: maxFileBytes,
              })
              continue
            }
            // eslint-disable-next-line no-await-in-loop
            const f = await fileStore.getOutputFile(taskId, meta.name)
            if (!f) continue
            fileArtifacts.push({
              kind: "file",
              file: { name: f.name, mimeType: f.mimeType, bytes: f.bytes.toString("base64") },
            })
          }
          // Re-persist inline file artifacts from downstream agents to Tasks.inputFiles.
          // Exclude emit_file_part outputs — those are this agent's own artifacts, not
          // downstream files, and re-persisting them would create spurious /uploads/ entries.
          // Enforce the same size + MIME guard as inbound uploads so a malicious
          // sub-agent cannot bypass the cap by echoing an oversized FilePart.
          await Promise.all(
            fileArtifacts
              .slice(0, source1Count)
              .filter((fa) => {
                if (!fa.file?.bytes || !fa.file?.name || fa._fromEmitFilePart) return false
                const rejection = checkInputFile(fa.file, cds.env.agents?.fileIO)
                if (rejection) {
                  LOG.warn("downstream file re-persist rejected", {
                    conversation: short(contextId),
                    service: serviceName,
                    name: fa.file.name,
                    reason: rejection,
                  })
                  return false
                }
                return true
              })
              .map((fa) => {
                const buf = Buffer.from(fa.file.bytes, "base64")
                const safeName = sanitizeFilename(fa.file.name)
                return fileStore.saveInputFile(taskId, safeName, fa.file.mimeType, buf)
              }),
          )
        }

        // Strip internal tag before publishing — clients must not see _fromEmitFilePart.
        // Capture source classification for the log line below.
        for (const filePart of fileArtifacts) {
          if (!filePart.file?.name) {
            LOG.warn("skipping malformed file artifact", {
              conversation: short(contextId),
              service: serviceName,
            })
            continue
          }
          const source = filePart._fromEmitFilePart ? "emit_file_part" : "outputs/"
          delete filePart._fromEmitFilePart
          const safeName = sanitizeFilename(filePart.file.name)
          const decodedSize =
            typeof filePart.file?.bytes === "string"
              ? Buffer.byteLength(filePart.file.bytes, "base64")
              : 0
          LOG.info("file emitted", {
            conversation: short(contextId),
            service: serviceName,
            name: safeName,
            mimeType: filePart.file?.mimeType,
            bytes: decodedSize,
            source,
          })
          eventBus.publish({
            kind: "artifact-update",
            taskId,
            contextId,
            artifact: {
              artifactId: `file-${safeName}`,
              name: safeName,
              parts: [filePart],
            },
          })
        }

        // Programmatic .chat() path: stash graph result on eventBus so chat.js
        // can read messages without an extra checkpoint roundtrip.
        if (eventBus[COLLECT_RESULT]) {
          eventBus._graphResult = { messages: result.messages || [] }
        }

        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: "completed",
            message: agentMessage(output),
            timestamp: new Date().toISOString(),
          },
          final: true,
        })
      } catch (err) {
        // Aborted (client disconnect or tasks/cancel) — publish canceled, not failed
        // Use name check (not instanceof) to also catch native DOMException AbortError from LangGraph
        if (err.name === "AbortError") {
          LOG.info("canceled", { conversation: short(contextId), service: serviceName })
          if (wfSpan) wfSpan.setAttribute("agent.outcome", "canceled")

          audit("AgentTaskCanceled", {
            data: { taskId, contextId, service: serviceName },
          })

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state: "canceled",
              message: agentMessage("Task canceled."),
              timestamp: new Date().toISOString(),
            },
            final: true,
          })
          return
        }

        // Timeout — attempt graceful summary of work-in-progress before reporting
        if (err.name === "TimeoutError") {
          LOG.warn("timeout", { conversation: short(contextId), service: serviceName })

          if (wfSpan) wfSpan.setAttribute("agent.outcome", "timeout")
          metrics.errorsTotal.add(1, { ...mAttrs, "agent.error.code": "timeout" })

          const summary = await this._summarizePartialWork(
            taskId,
            contextId,
            serviceName,
            "timed out",
          )

          audit("AgentTaskFailed", {
            data: {
              taskId,
              contextId,
              service: serviceName,
              error: err.message,
              errorCode: "timeout",
              task: requestContext.task,
            },
          })

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state: "canceled",
              message: agentMessage(summary),
              timestamp: new Date().toISOString(),
            },
            final: true,
          })
          return
        }

        // Quota exceeded — summarize partial work instead of raw error
        if (err.quotaExceeded) {
          LOG.warn("quota exceeded", {
            conversation: short(contextId),
            service: serviceName,
            error: err.message,
          })

          if (wfSpan) wfSpan.setAttribute("agent.outcome", "quota_exceeded")
          metrics.errorsTotal.add(1, { ...mAttrs, "agent.error.code": "quota_exceeded" })

          const summary = await this._summarizePartialWork(
            taskId,
            contextId,
            serviceName,
            "quota exceeded",
          )

          audit("AgentTaskFailed", {
            data: {
              taskId,
              contextId,
              service: serviceName,
              error: err.message,
              errorCode: "quota_exceeded",
              task: requestContext.task,
            },
          })

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state: "canceled",
              message: agentMessage(summary),
              timestamp: new Date().toISOString(),
            },
            final: true,
          })
          return
        }

        LOG.error("failed", {
          conversation: short(contextId),
          service: serviceName,
          error: err.message,
        })
        LOG.debug("failed stack", {
          conversation: short(contextId),
          service: serviceName,
          stack: err.stack,
        })

        if (wfSpan) {
          wfSpan.setAttribute("agent.outcome", "failed")
          wfSpan.setStatus({ code: 2, message: err.message })
        }

        const errorCode = err.message?.includes("timed out") ? "timeout" : "execution_failed"
        metrics.errorsTotal.add(1, { ...mAttrs, "agent.error.code": errorCode })

        // Audit: task failed
        audit("AgentTaskFailed", {
          data: {
            taskId,
            contextId,
            service: serviceName,
            error: err.message,
            errorCode,
            task: requestContext.task,
          },
        })
        // In production, don't reveal internal error details to clients (CDS pattern)
        const PROD = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
        const errorMsg =
          PROD && err.$sanitize !== false
            ? cds.i18n.messages.at(500) || "Internal Server Error"
            : `Agent error: ${err.message}`

        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: "failed",
            message: agentMessage(errorMsg),
            timestamp: new Date().toISOString(),
          },
          final: true,
        })
      } finally {
        // setSpanAttrs must happen at the end for the linking as else prompt might not yet have been created
        const rootSpan = cds.context["_mlflow.rootSpan"]
        setSpanAttrs(rootSpan, linkTraceToPrompt())

        this._abortControllers.delete(taskId)
        metrics.concurrentExecutions.add(-1, mAttrs)

        // Update task record with usage data (non-blocking, best effort)
        // When result is undefined (quota exceeded, timeout, abort), recover
        // messages from the checkpoint for usage tracking.
        const graph = this._graph
        cds.spawn(async () => {
          try {
            let messages = result?.messages
            if (!messages && graph?.checkpointer) {
              try {
                const thread_id = `${serviceName}:${contextId}`
                let cp = await graph.checkpointer.getTuple({ configurable: { thread_id } })
                if (!cp?.checkpoint?.channel_values && graph.checkpointer.latestNamespace) {
                  const ns = await graph.checkpointer.latestNamespace(thread_id)
                  if (ns) {
                    cp = await graph.checkpointer.getTuple({
                      configurable: { thread_id, checkpoint_ns: ns },
                    })
                  }
                }
                messages = cp?.checkpoint?.channel_values?.messages
              } catch {
                /* best-effort */
              }
            }
            const updates = { agentService: serviceName }
            if (usageData?.total_tokens != null) {
              updates.usageLlmTokens = usageData.total_tokens
            } else if (messages) {
              const recovered = aggregateUsageData(messages)
              if (recovered?.total_tokens) updates.usageLlmTokens = recovered.total_tokens
            }
            if (messages) updates.usageToolCalls = totalToolCalls(messages)
            await UPDATE("cap.agent.Tasks").where({ taskId }).with(updates)
          } catch (err) {
            LOG.debug("usage update failed", { conversation: short(contextId), error: err.message })
          }
        })

        eventBus.finished()
      }
    }

    if (tracer) {
      await tracer.startActiveSpan(`workflow CompiledStateGraph ${serviceName}`, async (wfSpan) => {
        if (!cds.context["_mlflow.rootSpan"]) {
          cds.context["_mlflow.rootSpan"] = wfSpan
        }
        try {
          await runWorkflow(wfSpan)
        } finally {
          wfSpan.end()
        }
      })
    } else {
      await runWorkflow(null)
    }
  }

  async cancelTask(taskId, eventBus) {
    const wasRunning = this._abortControllers.has(taskId)
    this.abort(taskId)

    if (!wasRunning) {
      audit("AgentTaskCanceled", {
        data: { taskId, service: this._srv.name },
      })

      eventBus.publish({
        kind: "status-update",
        taskId,
        status: {
          state: "canceled",
          message: agentMessage("Task canceled."),
          timestamp: new Date().toISOString(),
        },
        final: true,
      })
      eventBus.finished()
    }
  }
}

export {
  GraphExecutor,
  messageText,
  defaultOutputMapper,
  agentMessage,
  parseResumeDecision,
  decisionTypeOf,
  extractInterruptData,
  composeEditNote,
}

/**
 * @param {[import('@langchain/core/messages').Message]} messages
 */
function aggregateUsageData(messages) {
  const result = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
  }
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].usage_metadata) continue
    const innerRes = convertUsageData(messages[i].usage_metadata)
    Object.keys(innerRes).forEach((k) => {
      if (innerRes[k] != null) result[k] += innerRes[k]
    })
  }
  return result
}

/**
 * @param {[import('@langchain/core/messages').Message]} messages
 */
function totalToolCalls(messages) {
  return messages.reduce((acc, val) => {
    if (val.type === "tool") acc++
    return acc
  }, 0)
}

/**
 * @param {[import('@langchain/core/messages').Message]} messages
 */
function toolCallsShortened(messages) {
  return messages.reduce((acc, val) => {
    if (val.type === "tool") acc.push(val.name)
    return acc
  }, [])
}
