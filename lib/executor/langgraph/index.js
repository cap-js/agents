import cds from "@sap/cds"
import { GraphExecutor } from "../graph.js"
import { resolveTools } from "../../tools.js"
import { createModel } from "../../llm.js"
import { buildSystemPrompt } from "../../system-prompt.js"
import { CdsCheckpointSaver } from "../../persistence/checkpoint-saver.js"
import { createAgentState } from "./state.js"
import { createManagedAgentNodes } from "./nodes/index.js"
import { createAgentGraph } from "./graph.js"

const LOG = cds.log("agent")

/**
 * LangGraph-based executor service for @agent annotated services.
 * Builds a ReAct agent graph from the CDS model, then delegates execution to GraphExecutor.
 */
export default class LangGraphExecutorService extends cds.Service {
  async init() {
    this._executors = new Map()
    this._initPromises = new Map()

    // Register active users computation event (apps can trigger manually)
    this.on("computeActiveUsers", async () => {
      const { computeActiveUsers } = await import("../../telemetry/active-users.js")
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
      const { tools, toolMap } = await resolveTools(srv)
      const toolNames = Object.keys(toolMap)
      LOG.debug("Initializing", { service: srv.name, tools: toolNames.length, toolNames })

      const model = await createModel({ srv, tools })
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
