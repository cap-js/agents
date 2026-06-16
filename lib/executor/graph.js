import cds from "@sap/cds"
import { short, audit } from "../utils.js"
import * as metrics from "../telemetry/metrics.js"
import { mlflowAttrs, mlflowTraceAttrs, setSpanAttrs } from "../telemetry/mlflow.js"

const LOG = cds.log("a2a")

/**
 * Default input mapper: extracts text from A2A message parts and wraps as HumanMessage.
 */
async function defaultInputMapper(requestContext) {
  const { HumanMessage } = await import("@langchain/core/messages")
  const text =
    requestContext.userMessage?.parts
      ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
      .map((p) => p.text)
      .join(" ") || ""
  return { messages: [new HumanMessage(text)] }
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
 *   this.a2a = { graph: myCompiledGraph }
 *   this.a2a = { graph: asyncGraphPromise, inputMapper, outputMapper, timeout, configMapper }
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
  }

  async _resolveGraph() {
    if (this._graph) return this._graph
    const resolved = await this._rawGraph
    if (!resolved || typeof resolved.invoke !== "function") {
      throw new Error(
        `srv.a2a.graph must be a compiled LangGraph graph (with an invoke() method). Got: ${typeof resolved}`,
      )
    }
    // Auto-inject CdsCheckpointSaver if graph has no checkpointer (enables multi-turn + HITL)
    if (!resolved.checkpointer && this._options?.checkpointer !== false) {
      const { CdsCheckpointSaver } = await import("../persistence/checkpoint-saver.js")
      resolved.checkpointer = new CdsCheckpointSaver()
      LOG.debug("Auto-injected CdsCheckpointSaver", { service: this._srv.name })
    }
    this._graph = resolved
    return this._graph
  }

  async _invokeWithTimeout(graph, input, config) {
    const timeout = cds.env.a2a?.pool?.maxExecutionTimeMsPerTask || 300_000
    let timeoutHandle
    return Promise.race([
      graph.invoke(input, config),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Graph execution timed out after ${timeout / 1000}s`)),
          timeout,
        )
      }),
    ]).finally(() => clearTimeout(timeoutHandle))
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const serviceName = this._srv.name
    const isResume = requestContext.task?.status?.state === "input-required"
    const mAttrs = metrics.attrs(serviceName)
    const userText = extractText(requestContext)

    // A2A correlation on HTTP span + log context
    const httpSpan = metrics.getActiveSpan()
    if (httpSpan) {
      httpSpan.setAttribute("a2a.task.id", taskId)
      httpSpan.setAttribute("a2a.context.id", contextId)
      httpSpan.setAttribute("a2a.service", serviceName)
    }
    if (cds.context) {
      cds.context["a2a.task.id"] = taskId
      cds.context["a2a.context.id"] = contextId
      cds.context["a2a.service"] = serviceName
    }

    metrics.concurrentExecutions.add(1, mAttrs)

    if (!isResume) {
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
        wfSpan.setAttribute("a2a.span.kind", "workflow")
        wfSpan.setAttribute("a2a.task.id", taskId)
        wfSpan.setAttribute("a2a.context.id", contextId)
        wfSpan.setAttribute("a2a.service", serviceName)
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
          configurable: {
            ...extraConfig,
            thread_id: `${serviceName}:${contextId}`,
            _taskId: taskId,
            _service: serviceName,
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

          result = await this._invokeWithTimeout(graph, new Command({ resume }), config)
        } else {
          const inputMapper = this._inputMapper || defaultInputMapper
          const input = await inputMapper(requestContext)
          result = await this._invokeWithTimeout(graph, input, config)
        }

        // Capture result for usage tracking in finally block
        lastResult = result

        if (result?.__interrupt__?.length > 0) {
          const description = extractInterruptDescription(result)

          LOG.info("input-required", { task: short(taskId), service: serviceName })

          if (wfSpan) wfSpan.setAttribute("a2a.outcome", "input-required")

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
          wfSpan.setAttribute("a2a.outcome", "completed")
          setSpanAttrs(
            wfSpan,
            mlflowAttrs("AGENT", { outputs: output?.slice(0, 1000), functionName: serviceName }),
          )
        }

        metrics.workflowsCompleted.add(1, mAttrs)
        metrics.agentActions.add(1, { "sap.tenantId": mAttrs["sap.tenantId"] })

        // Audit: task completed
        audit("AgentTaskCompleted", {
          data: {
            taskId,
            contextId,
            service: serviceName,
            duration,
            tokens: lastResult?._totalTokens,
            toolCalls: lastResult?._totalToolCalls,
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
        LOG.error("failed", { task: short(taskId), service: serviceName, error: err.message })
        LOG.debug("failed stack", { task: short(taskId), service: serviceName, stack: err.stack })

        if (wfSpan) {
          wfSpan.setAttribute("a2a.outcome", "failed")
          wfSpan.setStatus({ code: 2, message: err.message })
        }

        const errorCode = err.message?.includes("timed out") ? "timeout" : "execution_failed"
        metrics.errorsTotal.add(1, { ...mAttrs, "a2a.error.code": errorCode })

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
            if (usageState?._totalTokens != null) updates.usageLlmTokens = usageState._totalTokens
            if (usageState?._totalToolCalls != null)
              updates.usageToolCalls = usageState._totalToolCalls
            await UPDATE("cap.a2a.Tasks").where({ taskId }).with(updates)
          } catch (err) {
            LOG.debug("usage update failed", { task: short(taskId), error: err.message })
          }
        })
      }

      eventBus.finished()
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
    // Audit: task canceled
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

export { GraphExecutor }
