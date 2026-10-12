import cds from "@sap/cds"
import { context, trace } from "@opentelemetry/api"
import { short, ms4 } from "../../lib/utils/utils.js"
import { agentMessage, partsToText, buildChatMessages } from "../../lib/utils/message-handling.js"
import * as metrics from "../../lib/telemetry/metrics.js"
import { mlflowAttrs, mlflowTraceAttrs, setSpanAttrs } from "../../lib/telemetry/mlflow/index.js"
import { resolvePseudonyms } from "../../lib/masking/index.js"
import { pseudonymizeUserMessage } from "../../lib/masking/unstructured/index.js"
import { triggerCleanup } from "../../lib/protocol/persistence/cleanup.js"
import { COLLECT_RESULT } from "./chat.js"
import { linkTraceToPrompt } from "../../lib/telemetry/mlflow/tracing.js"
import {
  handleHitlInterrupt,
  isTimeoutHitl,
  publishTimeoutHitl,
  requiresHitl,
  resumeHitl,
  resumeTimeoutHitl,
} from "./graph-executor/hitl.js"
import { registerShutdownHook } from "./graph-executor/crash-handler.js"
import {
  AbortError,
  TimeoutError,
  defaultInputMapper,
  defaultOutputMapper,
  messageText,
} from "./graph-executor/helpers.js"
import { createFileStore, persistInputFiles, publishOutputFiles } from "./graph-executor/fileIO.js"
import { aggregateUsageData, recordUsage } from "./graph-executor/usage.js"

const LOG = cds.log("agents")

// Called via langgraph-executor-srv.js or chat.js
class GraphExecutor {
  constructor(graph, srv, options = {}) {
    this._srv = srv
    this._options = options
    this._graph = Promise.resolve(graph).then(async (resolved) => {
      if (!resolved || typeof resolved.invoke !== "function") {
        throw new Error(
          `buildGraph must return a compiled LangGraph graph (with an invoke() method). Got: ${typeof resolved}`,
        )
      }
      if (!resolved.checkpointer && this._options?.checkpointer !== false) {
        const { CdsCheckpointSaver } =
          await import("../../lib/protocol/persistence/checkpoint-saver.js")
        resolved.checkpointer = new CdsCheckpointSaver()
        LOG.debug(this._srv.name, "- auto-injected CdsCheckpointSaver")
      }
      return resolved
    })
    this._inputMapper = options.inputMapper || null
    this._outputMapper = options.outputMapper || null
    this._configMapper = options.configMapper || null
    this._recursionLimit = options.recursionLimit ?? null
    /** @type {Map<string, AbortController>} per-task abort controllers */
    this._abortControllers = new Map()
    /** @type {Map<string, string | undefined>} task tenant by task ID */
    this._taskTenants = new Map()
    registerShutdownHook(this)
  }

  /**
   * Abort a running task execution. Called on client disconnect or tasks/cancel.
   * Safe to call multiple times or for unknown taskIds.
   */
  abort(taskId, eventBus) {
    const controller = this._abortControllers.get(taskId)
    if (controller) {
      if (!controller.signal.aborted) {
        LOG.info(this._srv.name, "aborting", { task: short(taskId) })
        controller.abort()
      }
      return
    }
    if (eventBus) {
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

  /** Invoke graph with shared timeout and cancellation handling. */
  async _invokeAgent(graph, input, config, signal) {
    const maxExecution = ms4(cds.env.agents?.quotas?.maxExecutionTimePerTask || "5min")
    const timeoutController = new AbortController()
    const timeoutHandle = setTimeout(() => timeoutController.abort(), maxExecution)
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    config.signal = combinedSignal
    try {
      if (typeof graph.stream !== "function" || cds.env.agents?.streaming === false) {
        return { state: await graph.invoke(input, config), tokenCount: 0 }
      }
      return await this._streamWithPublish(graph, input, config)
    } catch (err) {
      if (combinedSignal.aborted) {
        if (signal?.aborted) throw new AbortError("Task execution aborted")
        throw new TimeoutError(`Graph execution timed out after ${maxExecution / 1000}s`, {
          timeout: maxExecution,
        })
      }
      throw err
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  /** Publish streaming graph output. */
  async _streamWithPublish(graph, input, config) {
    const eventBus = cds.context["agent.eventBus"]
    const taskId = cds.context["agent.task.id"]
    const contextId = cds.context["agent.context.id"]

    let tokenCount = 0
    let finalState = null
    // Track the current turn (langchain message id). Each new turn opens a fresh
    // bubble on the client via `append:false`; subsequent tokens of the same turn
    // are `append:true` (accumulate). Anthropic-style turns can stream a text
    // preamble BEFORE their tool_use block ("Let me first look up …") — we let
    // that reasoning text stream normally; the client is responsible for the
    // final visual (collapse to the last turn's bubble at task completion).
    let currentMsgId = null
    let thinkingCount = 0
    let thinkingMsgId = null
    // Holds a trailing fragment of the previous chunk that is a prefix of a known
    // pseudonym hash. Prepended to the next chunk so split hashes are resolved correctly.
    let pendingPrefix = ""

    const streamConfig = {
      ...config,
      streamMode: ["messages", "updates"],
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
          tokenCount = 0
        }

        const lastChunk =
          !!msgChunk.additional_kwargs?.intermediate_results?.llm?.choices[0].finish_reason

        const raw = pendingPrefix + (messageText(msgChunk?.content) ?? "")
        pendingPrefix = ""
        if (!raw) continue

        if (thinkingMsgId !== null && currentMsgId !== thinkingMsgId) thinkingCount++
        thinkingMsgId = currentMsgId

        // Hashes look like name-8hexchars and never contain spaces.
        // On non-last chunks, slice last token and append to next chunk
        // to avoid unresolved boundaries
        let toEmit = raw
        if (!lastChunk) {
          const lastSpace = raw.lastIndexOf(" ")
          if (lastSpace !== -1 && lastSpace < raw.length - 1) {
            pendingPrefix = raw.slice(lastSpace + 1)
            toEmit = raw.slice(0, lastSpace + 1)
          }
        }

        const text = resolvePseudonyms(toEmit)
        // A2A TaskArtifactUpdateEvent: `append` and `lastChunk` are event-level
        // fields (siblings of `artifact`), NOT properties of `artifact`. The SDK's
        // ResultManager reads event.append; nesting them leaves it undefined and
        // forces replace-on-every-chunk instead of accumulation.
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          append: tokenCount > 0,
          lastChunk: lastChunk,
          artifact: {
            artifactId: `thinking-${thinkingCount}`,
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
            finalState = {
              ...finalState,
              __interrupt__: payload.__interrupt__,
            }
          }
        }
      }
    }

    // Recover the fully-reduced state from the checkpoint. The streamed updates only
    // carry per-node message deltas, so channel_values is the authoritative source for
    // the complete message list (required by the file-I/O scan below and outputMapper).
    // The __interrupt__ captured from the updates stream is preserved — it is an
    // ephemeral signal that may already be cleared from channel_values.
    if (graph.checkpointer) {
      try {
        const thread_id = config.configurable?.thread_id
        let cp = await graph.checkpointer.getTuple({
          configurable: { thread_id },
        })
        if (!cp?.checkpoint?.channel_values && graph.checkpointer.latestNamespace) {
          const ns = await graph.checkpointer.latestNamespace(thread_id)
          if (ns) {
            cp = await graph.checkpointer.getTuple({
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
   * Summarize partial work after forced interruption (timeout, quota, etc.).
   */
  async _summarizePartialWork(taskId, contextId, serviceName, reason) {
    const { summarizePartialWork } = await import("../../lib/agents/summarize-on-timeout.js")
    const graph = await this._graph
    return resolvePseudonyms(
      await summarizePartialWork({
        taskId,
        contextId,
        serviceName,
        reason,
        checkpointer: graph.checkpointer,
        getModel: () => this._srv.send("buildModel"),
      }),
    )
  }

  async execute(requestContext, eventBus) {
    const tracer = metrics.getTracer()
    const span = tracer?.startSpan(`workflow CompiledStateGraph ${this._srv.name}`)
    if (span && !cds.context["_mlflow.rootSpan"]) cds.context["_mlflow.rootSpan"] = span
    const activeContext = span ? trace.setSpan(context.active(), span) : context.active()
    try {
      await context.with(activeContext, () =>
        requestContext.task?.status?.state === "input-required"
          ? this._resumeWorkflow(requestContext, eventBus)
          : this._startWorkflow(requestContext, eventBus),
      )
    } finally {
      span?.end()
    }
  }

  async _initializeWorkflow(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const serviceName = this._srv.name
    if (!cds.context) throw Error(`Agent ${serviceName} must be called with cds.context in place!`)
    cds.context["agent.task.id"] = taskId
    cds.context["agent.context.id"] = contextId
    cds.context["agent.service"] = serviceName
    cds.context["agent.eventBus"] = eventBus
    const agentContext = (cds.context["agent"] ??= {})
    agentContext.request = requestContext
    agentContext.fileStore = createFileStore()
    cds.context["agent.request.metadata"] = requestContext.userMessage?.metadata ?? {}
    const controller = new AbortController()
    this._abortControllers.set(taskId, controller)
    this._taskTenants.set(taskId, cds.context.tenant)
    const graph = await this._graph
    if (cds.env.agents.masking) {
      await pseudonymizeUserMessage(
        this._srv,
        requestContext,
        graph.checkpointer,
        `${serviceName}:${contextId}`,
      )
    }
    metrics.concurrentExecutions.add(1, metrics.attrs(serviceName))
    return graph
  }

  async _startWorkflow(requestContext, eventBus) {
    const graph = await this._initializeWorkflow(requestContext, eventBus)
    const { taskId, contextId } = requestContext
    const serviceName = cds.context["agent.service"]
    if (cds.context["agent.new.task"]) {
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
    cds.spawn({}, async () => triggerCleanup(serviceName))
    await persistInputFiles()
    return this._runWorkflow({ graph, runGraph: this._startGraph })
  }

  async _resumeWorkflow(requestContext, eventBus) {
    const graph = await this._initializeWorkflow(requestContext, eventBus)
    return this._runWorkflow({ graph, runGraph: this._resumeGraph })
  }

  async _startGraph({ graph, config }) {
    const inputMapper = this._inputMapper || defaultInputMapper
    const rawInput = await inputMapper(cds.context["agent"].request)
    const { _toolMapOverride, ...input } = rawInput
    if (_toolMapOverride) config.configurable._toolMapOverride = _toolMapOverride
    const streamed = await this._invokeAgent(
      graph,
      input,
      config,
      this._abortControllers.get(cds.context["agent.task.id"]).signal,
    )
    return streamed.state
  }

  async _resumeGraph({ graph, config }) {
    const requestContext = cds.context["agent"].request
    const resume = isTimeoutHitl(requestContext.task) ? resumeTimeoutHitl : resumeHitl
    return resume({
      requestContext,
      graph,
      config,
      eventBus: cds.context["agent.eventBus"],
      signal: this._abortControllers.get(cds.context["agent.task.id"]).signal,
      stream: (input, signal) => this._invokeAgent(graph, input, config, signal),
    })
  }

  async _runWorkflow({ graph, runGraph }) {
    const requestContext = cds.context["agent"].request
    const fileStore = cds.context["agent"].fileStore
    const eventBus = cds.context["agent.eventBus"]
    const serviceName = cds.context["agent.service"]
    const taskId = cds.context["agent.task.id"]
    const contextId = cds.context["agent.context.id"]
    const mAttrs = metrics.attrs(serviceName)
    const span = trace.getActiveSpan()
    if (span) {
      span.setAttribute("gen_ai.operation.name", "invoke_agent")
      span.setAttribute("gen_ai.agent.name", serviceName)
      span.setAttribute("agent.task.id", taskId)
      span.setAttribute("agent.context.id", contextId)
      span.setAttribute("agent.service", serviceName)
      // MLflow: workflow span carries AGENT type + inputs for the
      // span-detail view
      span.setAttribute("mlflow.message.format", "langchain-js")
      setSpanAttrs(
        span,
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
      const userText = partsToText(requestContext.userMessage?.parts)
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
        span.setAttribute("mlflow.sourceRun", evalRunId)
      }
    }
    let usageData
    let result
    try {
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: { state: "working", timestamp: new Date().toISOString() },
        final: false,
      })
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
      result = await runGraph.call(this, { graph, config })
      if (!result) return
      // Capture result for usage tracking in finally block
      // (interrupt-only results may have no `messages` — treat as empty)
      usageData = aggregateUsageData(result.messages || [])
      const duration = ((Date.now() - t0) / 1000).toFixed(1) + "s"
      if (requiresHitl(result)) {
        handleHitlInterrupt({
          result,
          requestContext,
          eventBus,
          serviceName,
          duration,
          onInputRequired: (description) => {
            if (!span) return
            span.setAttribute("agent.outcome", "input-required")
            const outputs = {
              choices: [{ message: { role: "assistant", content: description } }],
            }
            setSpanAttrs(span, mlflowAttrs("AGENT", { outputs }))
            setSpanAttrs(cds.context?.["_mlflow.rootSpan"], mlflowAttrs("CHAIN", { outputs }))
          },
        })
        return
      }
      const outputMapper = this._outputMapper || defaultOutputMapper
      const output = resolvePseudonyms(outputMapper(result)) || "I could not generate a response."
      LOG.info(serviceName, "completed", {
        conversation: short(contextId),
        duration,
      })
      if (span) {
        span.setAttribute("agent.outcome", "completed")
        setSpanAttrs(
          span,
          mlflowAttrs("AGENT", {
            outputs: {
              choices: [{ message: { role: "assistant", content: output } }],
            },
            functionName: serviceName,
          }),
        )
      }
      const rootSpan = cds.context?.["_mlflow.rootSpan"]
      if (rootSpan) {
        setSpanAttrs(
          rootSpan,
          mlflowAttrs("CHAIN", {
            outputs: {
              choices: [{ message: { role: "assistant", content: output } }],
            },
          }),
        )
      }
      metrics.workflowsCompleted.add(1, mAttrs)
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
      await publishOutputFiles({
        result,
        taskId,
        contextId,
        serviceName,
        eventBus,
        log: LOG,
        fileStore,
      })
      // Programmatic .chat() path: stash graph result on eventBus so chat.js
      // can read messages without an extra checkpoint roundtrip.
      if (eventBus[COLLECT_RESULT]) {
        eventBus._graphResult = { messages: result.messages || [] }
      }
      const usageMeta =
        usageData?.total_tokens > 0 ? { "sap.cds.agents.token-usage": usageData } : undefined
      const responseMetadata = {
        ...usageMeta,
        "sap.cds.agents.duration": duration,
      }
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "completed",
          message: agentMessage(output, undefined, responseMetadata),
          timestamp: new Date().toISOString(),
        },
        final: true,
        metadata: responseMetadata,
      })
    } catch (err) {
      await this._handleWorkflowError(err)
    } finally {
      // setSpanAttrs must happen at the end for the linking as else prompt might not yet have been created
      setSpanAttrs(cds.context["_mlflow.rootSpan"], linkTraceToPrompt())
      this._abortControllers.delete(taskId)
      this._taskTenants.delete(taskId)
      metrics.concurrentExecutions.add(-1, mAttrs)
      recordUsage({
        graph: await this._graph,
        result,
        usageData,
      })
      eventBus.finished()
    }
  }

  async _handleWorkflowError(err) {
    const requestContext = cds.context["agent"].request
    const eventBus = cds.context["agent.eventBus"]
    const serviceName = cds.context["agent.service"]
    const taskId = cds.context["agent.task.id"]
    const contextId = cds.context["agent.context.id"]
    const span = trace.getActiveSpan()
    const outcome =
      err.name === "AbortError"
        ? "canceled"
        : err.name === "TimeoutError"
          ? "input-required"
          : err.quotaExceeded
            ? "quota_exceeded"
            : "failed"
    if (span) {
      span.setAttribute("agent.outcome", outcome)
      span.setStatus({ code: 2, message: err.message })
    }
    if (err.name === "AbortError") {
      LOG.info(serviceName, "-", "canceled", {
        conversation: short(contextId),
      })
      this._publishFinalStatus("canceled", "Task canceled.")
      return
    }
    if (err.name === "TimeoutError") {
      LOG.warn(serviceName, "-", "timeout", { conversation: short(contextId) })
      const summary = await this._summarizePartialWork(taskId, contextId, serviceName, "timeOut")
      publishTimeoutHitl({
        requestContext,
        eventBus,
        description: summary,
        serviceName,
      })
      return
    }
    if (err.quotaExceeded) {
      LOG.warn(serviceName, "-", "quota exceeded", {
        conversation: short(contextId),
        error: err.message,
      })
      metrics.errorsTotal.add(1, {
        ...metrics.attrs(serviceName),
        "agent.error.code": "quota_exceeded",
      })
      const summary = await this._summarizePartialWork(taskId, contextId, serviceName, "quota")
      this._publishFinalStatus("canceled", summary)
      return
    }
    LOG.error(Object.assign(err, { conversation: short(contextId) }))
    const errorCode = err.message?.includes("timed out") ? "timeout" : "execution_failed"
    metrics.errorsTotal.add(1, {
      ...metrics.attrs(serviceName),
      "agent.error.code": errorCode,
    })
    const production = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
    const message =
      production && err.$sanitize !== false
        ? cds.i18n.messages.at(500) || "Internal Server Error"
        : `Agent error: ${err.message}`
    this._publishFinalStatus("failed", message)
  }

  _publishFinalStatus(state, message) {
    const eventBus = cds.context["agent.eventBus"]
    eventBus.publish({
      kind: "status-update",
      taskId: cds.context["agent.task.id"],
      contextId: cds.context["agent.context.id"],
      status: {
        state,
        message: agentMessage(message),
        timestamp: new Date().toISOString(),
      },
      final: true,
    })
  }
}

export { GraphExecutor }
