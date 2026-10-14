import cds from "@sap/cds"

import { partsToText } from "../utils/message-handling.js"
import { SemanticEventBus } from './utils.js'

const LOG = cds.log("agents")

/**
 * A Pi-native A2A executor.
 */
export default class PiExecutor {
  _running = new Map() // REVISIT: Remove this and handle cancellation via db or event queue

  constructor(agentFactory) {
    this.agentFactory = agentFactory
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    let unsubscribe

    if (cds.context) {
      // REVISIT: one cds.context.agent = {...}
      cds.context["agent.task.id"] = taskId
      cds.context["agent.context.id"] = contextId
      cds.context["agent.eventBus"] = eventBus // event bus is a2a specific and should only be used in the protocol adapter
    }
    const bus = new SemanticEventBus(eventBus, taskId, contextId)

    if (!requestContext.task) {
      bus.updateStatus({ state: "submitted" }) // TODO: we should very much remove this
    }
    bus.updateStatus({ state: "working" })

    try {
      const agent = await this.agentFactory()
      this._running.set(taskId, { agent })

      unsubscribe = agent.subscribe((event) => {
        const update = event?.assistantMessageEvent
        if (event?.type === "message_update" && update?.type === "text_delta" && update?.delta) {
          bus.appendArtifact({ artifactId: "response", parts: [{ kind: "text", text: update.delta }] })
        }
      })

      const prompt = partsToText(requestContext.userMessage?.parts)
      await agent.prompt(prompt)

      const messages = agent.state?.messages || []
      const aiMsg = messages.findLast(m => m?.role === "assistant")

      this._running.delete(taskId)
      if (aiMsg?.stopReason === "aborted") {
        LOG.info("Task cancelled:", taskId)
        bus.updateStatus({ state: "canceled" })
        return
      }

      if (agent.state?.errorMessage) throw new Error(agent.state.errorMessage)

      const output = typeof aiMsg.content === "string" ? aiMsg.content :
        (aiMsg.content || [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text || "")
        .join("")

      bus.finalArtifact({ artifactId: "response", parts: [{ kind: "text", text: output }] })
      bus.updateStatus({ state: "completed" })
    } catch (error) {
      const text = cds.env.production
          ? cds.i18n.messages.at(500) || "Internal Server Error"
          : `Agent error: ${error.message}`
      LOG.error("Pi agent failed", error.stack)
      bus.updateStatus({ state: "failed", message: agentMessage(text) })
    } finally {
      this._running.delete(taskId)
      unsubscribe?.()
      eventBus.finished()
    }
  }

  async cancelTask(taskId) {
    LOG.info("Cancel task:", taskId)
    const running = this._running.get(taskId)
    running?.agent?.abort?.()
    this._running.delete(taskId)
  }
}

function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}

export { PiExecutor }
