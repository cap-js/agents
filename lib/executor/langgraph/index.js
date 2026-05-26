const cds = require("@sap/cds")
const { generateTools } = require("../../tools")
const { createModel } = require("../../llm")
const { buildSystemPrompt, agentMessage } = require("../../system-prompt")
const { CdsCheckpointSaver } = require("../../persistence/checkpoint-saver")
const { createAgentState } = require("./state")
const { createNodes } = require("./nodes")
const { createAgentGraph } = require("./graph")
const metrics = require("../../telemetry/metrics")

const LOG = cds.log("a2a")
const { short } = require("../../utils")

/**
 * LangGraph-based executor service.
 */
module.exports = class LangGraphExecutorService extends cds.Service {
  async init() {
    // Per-service configuration: srv.name => { graph, systemPrompt, checkpointer }
    this._states = new Map()
    this._initPromises = new Map()
    return super.init()
  }

  for(srv) {
    return {
      execute: (requestContext, eventBus) => this._execute(srv, requestContext, eventBus),
      cancelTask: (taskId, eventBus) => this._cancelTask(taskId, eventBus),
    }
  }

  async _ensureInitialized(srv) {
    if (this._states.has(srv.name)) return
    if (this._initPromises.has(srv.name)) return this._initPromises.get(srv.name)

    const promise = (async () => {
      const { tools, toolMap } = generateTools(srv)
      const toolNames = Object.keys(toolMap)
      LOG.debug("Initializing", { service: srv.name, tools: toolNames.length, toolNames })

      const model = await createModel(srv, tools)
      const systemPrompt = buildSystemPrompt(srv)
      // Checkpointer: persists graph state to CDS entities for multi-turn conversations
      const checkpointer = new CdsCheckpointSaver()

      const agentState = await createAgentState()
      const nodes = createNodes(model, toolMap)
      const graph = await createAgentGraph(agentState, nodes, checkpointer)

      this._states.set(srv.name, { graph, systemPrompt, checkpointer })
      this._initPromises.delete(srv.name)
    })().catch((err) => {
      this._initPromises.delete(srv.name)
      throw err
    })

    this._initPromises.set(srv.name, promise)
    return promise
  }

  async _execute(srv, requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const mAttrs = metrics.attrs(srv)
    const serviceName = srv.name

    const userText =
      requestContext.userMessage?.parts
        ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
        .map((p) => p.text)
        .join(" ") || ""

    metrics.concurrentExecutions.add(1, mAttrs)

    // A2A correlation on HTTP span + log context
    const httpSpan = metrics.getActiveSpan()
    if (httpSpan) {
      httpSpan.setAttribute("a2a.task.id", taskId)
      httpSpan.setAttribute("a2a.context.id", contextId)
    }
    if (cds.context) {
      cds.context["a2a.task.id"] = taskId
      cds.context["a2a.context.id"] = contextId
      cds.context["a2a.service"] = serviceName
    }

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

    const tracer = metrics.getTracer()
    const runWorkflow = async (wfSpan) => {
      if (wfSpan) {
        wfSpan.setAttribute("gen_ai.operation.name", "invoke_agent")
        wfSpan.setAttribute("gen_ai.agent.name", serviceName)
        wfSpan.setAttribute("a2a.span.kind", "workflow")
        wfSpan.setAttribute("a2a.task.id", taskId)
        wfSpan.setAttribute("a2a.context.id", contextId)
      }

      try {
        await this._ensureInitialized(srv)
        const { graph, systemPrompt, checkpointer } = this._states.get(serviceName)

        const config = {
          configurable: {
            thread_id: `${serviceName}:${contextId}`,
            _taskId: taskId,
            _service: serviceName,
          },
        }

        const existing = await checkpointer.getTuple(config)
        const tokensBefore = existing?.checkpoint?.channel_values?._totalTokens || 0

        const { SystemMessage, HumanMessage } = await import("@langchain/core/messages")
        const input = existing
          ? { messages: [new HumanMessage(userText)] }
          : { messages: [new SystemMessage(systemPrompt), new HumanMessage(userText)] }

        const t0 = Date.now()
        const result = await graph.invoke(input, config)
        const duration = ((Date.now() - t0) / 1000).toFixed(1) + "s"

        const iterations = result.iterations || 0
        const tokens = (result._totalTokens || 0) - tokensBefore
        LOG.info("completed", {
          task: short(taskId),
          service: serviceName,
          iterations,
          tokens,
          duration,
        })

        if (wfSpan) wfSpan.setAttribute("a2a.outcome", "completed")

        metrics.workflowsCompleted.add(1, mAttrs)
        metrics.agentActions.add(1, { "sap.tenantId": mAttrs["sap.tenantId"] })

        const output = result.output || "I could not generate a response."

        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: { artifactId: "response", parts: [{ text: output }] },
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

        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: "failed",
            message: agentMessage(`Agent error. Check the log output for details.`),
            timestamp: new Date().toISOString(),
          },
          final: true,
        })
      } finally {
        metrics.concurrentExecutions.add(-1, mAttrs)
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

  async _cancelTask(taskId, eventBus) {
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
