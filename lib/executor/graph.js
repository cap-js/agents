const cds = require("@sap/cds")
const { short } = require("../utils")

const LOG = cds.log("a2a")

/**
 * Default input mapper: extracts text from A2A message parts and wraps as HumanMessage.
 */
function defaultInputMapper(requestContext) {
  const { HumanMessage } = require("@langchain/core/messages")
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
 *   this.a2a = { graph: asyncGraphPromise, inputMapper, outputMapper, timeout }
 */
class GraphExecutor {
  constructor(graph, srv, options = {}) {
    this._rawGraph = graph
    this._graph = null
    this._srv = srv
    this._options = options
    this._inputMapper = options.inputMapper || null
    this._outputMapper = options.outputMapper || null
    this._timeout = options.timeout || 120000 // default 2 minutes
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
      const { CdsCheckpointSaver } = require("../persistence/checkpoint-saver")
      resolved.checkpointer = new CdsCheckpointSaver()
      LOG.debug("Auto-injected CdsCheckpointSaver", { service: this._srv.name })
    }
    this._graph = resolved
    return this._graph
  }

  async _invokeWithTimeout(graph, input, config) {
    let timeoutHandle
    return Promise.race([
      graph.invoke(input, config),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Graph execution timed out after ${this._timeout / 1000}s`)),
          this._timeout,
        )
      }),
    ]).finally(() => clearTimeout(timeoutHandle))
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const serviceName = this._srv.name
    const isResume = requestContext.task?.status?.state === "input-required"

    eventBus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
    })

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    })

    try {
      const graph = await this._resolveGraph()

      const config = {
        configurable: {
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
        const { Command } = require("@langchain/langgraph")
        const resume = parseResumeDecision(userText)

        LOG.info("↻ resuming", {
          task: short(taskId),
          service: serviceName,
          decision: resume.decisions[0].type,
        })
        result = await this._invokeWithTimeout(graph, new Command({ resume }), config)
      } else {
        const inputMapper = this._inputMapper || defaultInputMapper
        const input = await inputMapper(requestContext)
        result = await this._invokeWithTimeout(graph, input, config)
      }

      if (result?.__interrupt__?.length > 0) {
        const description = extractInterruptDescription(result)

        LOG.info("⏸ input-required", { task: short(taskId), service: serviceName })

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

      LOG.info("✓ completed", { task: short(taskId), service: serviceName, duration })

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
      LOG.error("✗ failed", { task: short(taskId), service: serviceName, error: err.message })
      LOG.debug("✗ stack", { task: short(taskId), service: serviceName, stack: err.stack })

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "failed",
          message: agentMessage(`Agent error: ${err.message}`),
          timestamp: new Date().toISOString(),
        },
        final: true,
      })
    }

    eventBus.finished()
  }

  async cancelTask(taskId, eventBus) {
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

module.exports = { GraphExecutor }
