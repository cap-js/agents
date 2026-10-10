import cds from "@sap/cds"

import { partsToText } from "../utils/message-handling.js"
import { SemanticEventBus } from './utils.js'

const LOG = cds.log("agents")

function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}

function messageContent(message) {
  if (typeof message.content === "string") return message.content
  return (message.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("")
}


/**
 * A Pi-native A2A executor. It intentionally does not construct or invoke a
 * LangGraph; only the existing CDS tool definitions are adapted and reused.
 */
export default class PiExecutor {
  _running = new Map()

  constructor(agentFactory, srv) {
    this.agentFactory = agentFactory
    this.srv = srv
  }

  async execute(requestContext, eventBus) {
    const { srv } = this
    const { taskId, contextId } = requestContext
    const controller = new AbortController()
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
      const agent = await this.agentFactory()
      this._running.set(taskId, { controller, agent })

      unsubscribe = agent.subscribe((event) => {
        const update = event?.assistantMessageEvent
        if (event?.type === "message_update" && update?.type === "text_delta" && update?.delta) {
          bus.appendArtifact({ artifactId: "response", parts: [{ kind: "text", text: update.delta }] })
        }
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
