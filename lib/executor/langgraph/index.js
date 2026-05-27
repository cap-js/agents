const cds = require("@sap/cds")
const { GraphExecutor } = require("../graph")
const { generateTools } = require("../../tools")
const { createModel } = require("../../llm")
const { buildSystemPrompt } = require("../../system-prompt")
const { CdsCheckpointSaver } = require("../../persistence/checkpoint-saver")
const { createAgentState } = require("./state")
const { createManagedAgentNodes } = require("./nodes")
const { createAgentGraph } = require("./graph")

const LOG = cds.log("a2a")

/**
 * LangGraph-based executor service for @a2a annotated services.
 * Builds a ReAct agent graph from the CDS model, then delegates execution to GraphExecutor.
 */
module.exports = class LangGraphExecutorService extends cds.Service {
  async init() {
    this._executors = new Map()
    this._initPromises = new Map()

    // Register active users computation event (apps can trigger manually)
    this.on("computeActiveUsers", async () => {
      const { computeActiveUsers } = require("../../telemetry/active-users")
      await computeActiveUsers()
    })

    return super.init()
  }

  for(srv) {
    return {
      execute: (requestContext, eventBus) => this._execute(srv, requestContext, eventBus),
      cancelTask: async (taskId, eventBus) => {
        const executor = await this._ensureExecutor(srv)
        return executor.cancelTask(taskId, eventBus)
      },
    }
  }

  async _ensureExecutor(srv) {
    if (this._executors.has(srv.name)) return this._executors.get(srv.name)
    if (this._initPromises.has(srv.name)) return this._initPromises.get(srv.name)

    const promise = (async () => {
      const { tools, toolMap } = generateTools(srv)
      const toolNames = Object.keys(toolMap)
      LOG.debug("Initializing", { service: srv.name, tools: toolNames.length, toolNames })

      const model = await createModel(srv, tools)
      const systemPrompt = buildSystemPrompt(srv)
      const checkpointer = new CdsCheckpointSaver()

      const agentState = await createAgentState()
      const nodes = createManagedAgentNodes(model, toolMap)
      const graph = await createAgentGraph(agentState, nodes, checkpointer)

      const executor = new GraphExecutor(graph, srv, {
        checkpointer: false, // already set on compiled graph
        inputMapper: async (requestContext) => {
          const { HumanMessage, SystemMessage } = await import("@langchain/core/messages")
          const text =
            requestContext.userMessage?.parts
              ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
              .map((p) => p.text)
              .join(" ") || ""

          const config = { configurable: { thread_id: `${srv.name}:${requestContext.contextId}` } }
          const existing = await checkpointer.getTuple(config)

          if (existing) {
            return { messages: [new HumanMessage(text)] }
          }
          return { messages: [new SystemMessage(systemPrompt), new HumanMessage(text)] }
        },
      })

      this._executors.set(srv.name, executor)
      this._initPromises.delete(srv.name)
      return executor
    })().catch((err) => {
      this._initPromises.delete(srv.name)
      throw err
    })

    this._initPromises.set(srv.name, promise)
    return promise
  }

  async _execute(srv, requestContext, eventBus) {
    const executor = await this._ensureExecutor(srv)
    return executor.execute(requestContext, eventBus)
  }
}
