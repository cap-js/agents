const cds = require("@sap/cds")
const { generateTools } = require("../../tools")
const { createModel } = require("../../llm")
const { buildSystemPrompt, agentMessage } = require("../../system-prompt")
const { createCheckpointSaver } = require("../../persistence/checkpoint-saver")
const { createAgentState } = require("./state")
const { createNodes } = require("./nodes")
const { createAgentGraph } = require("./graph")

const LOG = cds.log("a2a")

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
      LOG.info("Initializing agent", { service: srv.name })

      const { tools, toolMap } = generateTools(srv)
      const { model } = await createModel(tools)
      const systemPrompt = buildSystemPrompt(srv)
      // Checkpointer: persists graph state to CDS entities for multi-turn conversations
      const checkpointer = await createCheckpointSaver()

      const agentState = await createAgentState()
      const nodes = createNodes(model, toolMap)
      const graph = await createAgentGraph(agentState, nodes, checkpointer)

      this._states.set(srv.name, { graph, systemPrompt, checkpointer })
      this._initPromises.delete(srv.name)

      LOG.info("Agent initialized", { service: srv.name })
    })()

    this._initPromises.set(srv.name, promise)
    return promise
  }

  async _execute(srv, requestContext, eventBus) {
    const { taskId, contextId } = requestContext

    const userText =
      requestContext.userMessage?.parts
        ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
        .map((p) => p.text)
        .join(" ") || ""

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
      await this._ensureInitialized(srv)
      const { graph, systemPrompt, checkpointer } = this._states.get(srv.name)

      // contextId (A2A) => thread_id (LangGraph), namespaced by service to prevent cross-service collision
      const config = { configurable: { thread_id: `${srv.name}:${contextId}` } }

      // Check if this is a follow-up message in an existing conversation
      const existing = await checkpointer.getTuple(config)

      const { SystemMessage, HumanMessage } = await import("@langchain/core/messages")
      const input = existing
        ? { messages: [new HumanMessage(userText)] }
        : { messages: [new SystemMessage(systemPrompt), new HumanMessage(userText)] }

      LOG.info("Running agent graph", { taskId, service: srv.name, resuming: !!existing })
      const result = await graph.invoke(input, config)

      const output = result.output || "I could not generate a response."

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
      LOG.error("Agent execution failed", err.message)
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
    }

    eventBus.finished()
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
