import cds from "@sap/cds"
import { toJSONSchema } from "zod"

import { partsToText } from "../lib/utils/message-handling.js"

const LOG = cds.log("agents")

function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}

function toolText(result) {
  const value = Array.isArray(result) && result.length === 2 ? result[0] : result
  if (typeof value === "string") return value
  if (value == null) return ""
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : part?.text || JSON.stringify(part)))
      .join("\n")
  }
  return JSON.stringify(value)
}

/** Convert the existing CDS/LangChain tools to Pi's AgentTool contract. */
export function toPiTools(tools = []) {
  return tools
    .map((tool) => {
      let parameters = { type: "object", properties: {} }
      if (tool.schema) {
        try {
          parameters = toJSONSchema(tool.schema, { target: "draft-7" })
          delete parameters.$schema
        } catch (error) {
          LOG.warn(`Could not convert schema for Pi tool ${tool.name}`, error.message)
        }
      }

      return {
        name: tool.name,
        label: tool.name,
        description: tool.description || tool.name,
        parameters,
        execute: async (_toolCallId, args, signal) => {
          const result = await tool.invoke(args, { signal })
          return { content: [{ type: "text", text: toolText(result) }], details: {} }
        },
      }
    })
}

function messageContent(message) {
  if (typeof message.content === "string") return message.content
  return (message.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("")
}

/**
 * Attempt to reduce the verbose boilerplate of giving A2A updates
 */
class SemanticEventBus {
  /** @param {import('@a2a-js/sdk/server').ExecutionEventBus} base */
  constructor(base, taskId, contextId) {
    this.base = base
    this.taskId = taskId
    this.contextId = contextId
  }

  /**
   * @param {import('@a2a-js/sdk').TaskStatus} status 
   */
  updateStatus(status) {
    return this.base.publish({
      kind: "task",
      id: this.taskId,
      contextId: this.contextId,
      status: { timestamp: new Date().toISOString(), ...status },
    })
  }

  /**
   * @param {import('@a2a-js/sdk').Artifact1} artifact
   * @param {boolean} final
   * @param {boolean} append
   */
  updateArtifact(artifact, final = false, append = false) {
    return this.base.publish({
      kind: "artifact-update",
      taskId: this.taskId,
      contextId: this.contextId,
      append: append,
      lastChunk: final,
      artifact,
    })
  }

  /**
   * @param {import('@a2a-js/sdk').Artifact1} artifact 
   */
  appendArtifact(artifact) {
    return this.updateArtifact(artifact, false, true)
  }

  /**
   * @param {import('@a2a-js/sdk').Artifact1} artifact 
   */
  finalArtifact(artifact) {
    return this.updateArtifact(artifact, true)
  }

}

/**
 * A Pi-native A2A executor. It intentionally does not construct or invoke a
 * LangGraph; only the existing CDS tool definitions are adapted and reused.
 */
export default class PiExecutor {
  static _instance

  _sessions = new Map()
  _running = new Map()

  static for(srv, options = {}) {
    this._instance ??= new PiExecutor()
    return this._instance.for(srv, options)
  }

  for(srv, options = {}) {
    return {
      execute: (requestContext, eventBus) => this.execute(srv, options, requestContext, eventBus),
      cancelTask: (taskId, eventBus) => this.cancelTask(taskId, eventBus),
      abort: (taskId) => this.abort(taskId),
    }
  }

  _sessionKey(srv, contextId) {
    return `${cds.context?.tenant || "anonymous"}:${srv.name}:${contextId}`
  }

  async _createAgent(srv, options) {
    const { Agent } = await import("@earendil-works/pi-agent-core")
    const tools = await srv.send("buildTools")
    const llm = await srv.send("buildModel")
    const systemPrompt = await srv.send("buildSystemPrompt")
    if (!llm?.model || typeof llm.streamFn !== "function") {
      throw new Error(
        "Pi models must expose a model and streamFn; configure a Pi model kind such as pi-anthropic",
      )
    }

    return new Agent({
      initialState: {
        systemPrompt,
        model: llm.model,
        thinkingLevel: options.thinkingLevel || "off",
        tools: toPiTools(tools),
        messages: [],
      },
      streamFn: llm.streamFn,
      getApiKey: llm.getApiKey,
    })
  }

  async execute(srv, options, requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const controller = new AbortController()
    const sessionKey = this._sessionKey(srv, contextId)
    let agent
    let unsubscribe

    if (cds.context) {
      // REVISIT: one cds.context.agent = {...}
      cds.context["agent.task.id"] = taskId
      cds.context["agent.context.id"] = contextId
      cds.context["agent.service"] = srv.name
      cds.context["agent.eventBus"] = eventBus // event bus is a2a specific and should only be used in the protocol adapter
    }
    const bus = new SemanticEventBus(eventBus, taskId, contextId)

    this._running.set(taskId, { controller })
    if (!requestContext.task) {
      bus.updateStatus({ state: "submitted" }) // TODO: we should very much remove this
    }
    bus.updateStatus({ state: "working" })

    try {
      agent = this._sessions.get(sessionKey)
      if (!agent) {
        agent = await this._createAgent(srv, options)
        this._sessions.set(sessionKey, agent)
      }
      this._running.set(taskId, { controller, agent })

      unsubscribe = agent.subscribe((event) => {
        const update = event?.assistantMessageEvent
        if (event?.type !== "message_update" || update?.type !== "text_delta" || !update.delta) {
          return
        }
        bus.appendArtifact({ artifactId: "response", parts: [{ kind: "text", text: update.delta }] })
      })

      const prompt = partsToText(requestContext.userMessage?.parts)
      await agent.prompt(prompt)
      if (controller.signal.aborted) {
        bus.updateStatus({ state: "canceled", message: agentMessage("Task canceled.") })
        return
      }
      if (agent.state?.errorMessage) throw new Error(agent.state.errorMessage)

      const messages = agent.state?.messages || []
      const aiMsg = messages.findLast(m => m?.role === "assistant")
      const output = messageContent(aiMsg)
      bus.finalArtifact({ artifactId: "response", parts: [{ kind: "text", text: output }] })
      bus.updateStatus({ state: "completed" })
    } catch (error) {
      const production = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
      const text = production && error?.$sanitize !== false
          ? cds.i18n.messages.at(500) || "Internal Server Error"
          : `Agent error: ${error.message}`
      LOG.error("Pi agent failed", { service: srv.name, error: error.stack })
      bus.updateStatus({ state: "failed", message: agentMessage(text) })
    } finally {
      unsubscribe?.()
      this._running.delete(taskId)
      eventBus.finished()
    }
  }

  abort(taskId) {
    const running = this._running.get(taskId)
    if (!running) return
    running.controller.abort()
    running.agent?.abort?.()
  }

  async cancelTask(taskId, eventBus) {
    if (this._running.has(taskId)) return this.abort(taskId)
    const bus = new SemanticEventBus(eventBus, taskId)
    bus.updateStatus({ state: "canceled", message: agentMessage("Task canceled.") })
    eventBus.finished()
  }
}

export { PiExecutor }
