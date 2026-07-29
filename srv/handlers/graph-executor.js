import cds from "@sap/cds"
import { short, audit } from "../../lib/utils/utils.js"
import * as metrics from "../../lib/telemetry/metrics.js"
import { mlflowAttrs, mlflowTraceAttrs, setSpanAttrs } from "../../lib/telemetry/mlflow.js"
import { CdsFileStore } from "../../lib/protocol/persistence/file-store.js"
import { formatFileSize, sanitizeFilename } from "./tools.js"

const LOG = cds.log("agent")

/** Parse time-span value to ms. Uses cds.utils.ms4 (CDS 9+) with fallback for CDS 8. */
const ms4 =
  cds.utils.ms4 ||
  ((val) => {
    if (typeof val === "number") return val
    const m = /^(\d+)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hrs|hours?|d|days?|w|weeks?)?$/i.exec(
      String(val),
    )
    if (!m) return Number(val) || 0
    const n = Number(m[1])
    const unit = (m[2] || "ms").toLowerCase()
    const factors = {
      ms: 1,
      s: 1000,
      sec: 1000,
      second: 1000,
      seconds: 1000,
      m: 60000,
      min: 60000,
      minute: 60000,
      minutes: 60000,
      h: 3600000,
      hrs: 3600000,
      hour: 3600000,
      hours: 3600000,
      d: 86400000,
      day: 86400000,
      days: 86400000,
      w: 604800000,
      week: 604800000,
      weeks: 604800000,
    }
    return n * (factors[unit] || 1)
  })

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
  const text =
    requestContext.userMessage?.parts
      ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
      .map((p) => p.text)
      .join(" ") || ""
  const fullText = requestContext._fileManifest ? `${text}\n${requestContext._fileManifest}` : text
  return { messages: [new HumanMessage(fullText)] }
}

/**
 * Default output mapper: extracts response text from graph result.
 * Priority: last AI message content > result.output > JSON stringified result.
 */
function defaultOutputMapper(result) {
  // 1. Messages-based: last message content (standard LangChain pattern)
  if (result.messages?.length > 0) {
    const lastMsg = result.messages[result.messages.length - 1]
    const content = lastMsg?.content
    if (content) return typeof content === "string" ? content : JSON.stringify(content)
  }
  // 2. Output field (e.g. travel-sample pattern)
  if (result.output) return result.output
  // 3. Fallback
  return JSON.stringify(result)
}

/**
 * Construct a spec-compliant A2A Message object.
 */
function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}

/**
 * Extract user text from A2A message parts.
 */
function extractText(requestContext) {
  return (
    requestContext.userMessage?.parts
      ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
      .map((p) => p.text)
      .join(" ") || ""
  )
}

/**
 * Parse user's resume text into a HITL decision.
 * Maps to the format expected by deepagents' humanInTheLoopMiddleware.
 */
function parseResumeDecision(userText) {
  if (/^(approve|yes|confirm|ok)$/i.test(userText.trim())) {
    return { decisions: [{ type: "approve" }] }
  }
  return { decisions: [{ type: "reject", message: userText }] }
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
    const userText = extractText(requestContext)

    // Cooperative cancellation: per-task AbortController
    const controller = new AbortController()
    this._abortControllers.set(taskId, controller)

    // A2A correlation on HTTP span + log context
    const httpSpan = metrics.getActiveSpan()
    if (httpSpan) {
      httpSpan.setAttribute("agent.task.id", taskId)
      httpSpan.setAttribute("agent.context.id", contextId)
      httpSpan.setAttribute("agent.service", serviceName)
    }
    if (cds.context) {
      cds.context["agent.task.id"] = taskId
      cds.context["agent.context.id"] = contextId
      cds.context["agent.service"] = serviceName
      cds.context["agent.eventBus"] = eventBus
    }

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
              const buf = Buffer.from(file.bytes, "base64")
              await fileStore.saveInputFile(taskId, safeName, safeMime, buf)
              LOG.info("file uploaded", {
                task: short(taskId),
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
        // MLflow Databricks: root workflow span carries AGENT type + trace tags
        setSpanAttrs(wfSpan, mlflowAttrs("AGENT", { inputs: userText, functionName: serviceName }))
        setSpanAttrs(wfSpan, mlflowTraceAttrs())
      }

      let lastResult
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

        let result
        const t0 = Date.now()

        if (isResume) {
          const userText = extractText(requestContext)
          if (!userText.trim()) {
            throw new Error("Resume message must contain text (e.g. 'approve' or 'reject').")
          }
          const { Command } = await import("@langchain/langgraph")
          const resume = parseResumeDecision(userText)

          LOG.debug("resuming", {
            task: short(taskId),
            service: serviceName,
            decision: resume.decisions[0].type,
          })

          // Audit: task resumed with HITL decision
          audit("AgentTaskResumed", {
            data: {
              taskId,
              contextId,
              service: serviceName,
              decision: resume.decisions[0].type,
              userMessage: requestContext.userMessage,
            },
          })

          result = await this._invokeWithTimeout(
            graph,
            new Command({ resume }),
            config,
            controller.signal,
          )
        } else {
          const inputMapper = this._inputMapper || defaultInputMapper
          const rawInput = await inputMapper(requestContext)
          const { _toolMapOverride, ...input } = rawInput
          if (_toolMapOverride) config.configurable._toolMapOverride = _toolMapOverride
          result = await this._invokeWithTimeout(graph, input, config, controller.signal)
        }

        // Capture result for usage tracking in finally block
        lastResult = result

        if (result?.__interrupt__?.length > 0) {
          const description = extractInterruptDescription(result)

          LOG.info("input-required", { task: short(taskId), service: serviceName })

          if (wfSpan) wfSpan.setAttribute("agent.outcome", "input-required")

          // Audit: agent requires human input
          audit("AgentInputRequired", {
            data: {
              taskId,
              contextId,
              service: serviceName,
              description,
              userMessage: requestContext.userMessage,
            },
          })

          eventBus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state: "input-required",
              message: agentMessage(description),
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

        LOG.info("completed", { task: short(taskId), service: serviceName, duration })

        if (wfSpan) {
          wfSpan.setAttribute("agent.outcome", "completed")
          setSpanAttrs(
            wfSpan,
            mlflowAttrs("AGENT", { outputs: output?.slice(0, 1000), functionName: serviceName }),
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
            tokens: lastResult?.runTokenCount,
            toolCalls: lastResult?.runToolCallCount,
            output: output?.slice(0, 2000),
            task: requestContext.task,
          },
        })

        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: { artifactId: "response", parts: [{ kind: "text", text: output }] },
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
                  task: short(taskId),
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
                task: short(taskId),
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
          await Promise.all(
            fileArtifacts
              .slice(0, source1Count)
              .filter((fa) => fa.file?.bytes && fa.file?.name && !fa._fromEmitFilePart)
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
              task: short(taskId),
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
            task: short(taskId),
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
          LOG.info("canceled", { task: short(taskId), service: serviceName })
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
          LOG.warn("timeout", { task: short(taskId), service: serviceName })

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
            task: short(taskId),
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

        LOG.error("failed", { task: short(taskId), service: serviceName, error: err.message })
        LOG.debug("failed stack", { task: short(taskId), service: serviceName, stack: err.stack })

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
        this._abortControllers.delete(taskId)
        metrics.concurrentExecutions.add(-1, mAttrs)

        // Update task record with usage data (non-blocking, best effort)
        cds.spawn(async () => {
          try {
            const updates = { agentService: serviceName }
            let usageState = lastResult
            if (!usageState && this._graph?.checkpointer) {
              const cp = await this._graph.checkpointer.getTuple({
                configurable: { thread_id: `${serviceName}:${contextId}` },
              })
              usageState = cp?.checkpoint?.channel_values
            }
            if (usageState?.runTokenCount != null) updates.usageLlmTokens = usageState.runTokenCount
            if (usageState?.runToolCallCount != null)
              updates.usageToolCalls = usageState.runToolCallCount
            await UPDATE("cap.agent.Tasks").where({ taskId }).with(updates)
          } catch (err) {
            LOG.debug("usage update failed", { task: short(taskId), error: err.message })
          }
        })

        eventBus.finished()
      }
    }

    if (tracer) {
      await tracer.startActiveSpan(`workflow CompiledStateGraph ${serviceName}`, async (wfSpan) => {
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

export { GraphExecutor }
