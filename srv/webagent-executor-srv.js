import cds from "@sap/cds"

import { partsToText } from "../lib/utils/message-handling.js"
import { publishedStatus } from "./pi-executor-srv.js"
import { toPiTools } from "./pi-executor-srv.js"

const LOG = cds.log("agents")

async function defaultRuntime() {
  const { createHarness } = await import("@sap/webagent/harness")
  return { createHarness }
}

/**
 * A2A executor backed by the @sap/webagent AgentHarness.
 * Reuses the same CDS tool and model contracts as PiExecutor but delegates
 * the agent loop (including retry and context-compaction) to the webagent
 * harness instead of driving pi-agent-core's Agent directly.
 */
export default class WebAgentExecutor {
  static _instance
  static runtime = defaultRuntime

  _sessions = new Map()
  _running = new Map()

  static for(srv, options = {}) {
    this._instance ??= new WebAgentExecutor()
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

  async _createHarness(srv, options) {
    const [{ createHarness }, runtimeModel, tools, systemPrompt] = await Promise.all([
      this.constructor.runtime(),
      srv.send("buildModel"),
      srv.send("buildTools"),
      srv.send("buildSystemPrompt"),
    ])

    if (!runtimeModel?.model || typeof runtimeModel.streamFn !== "function") {
      throw new Error(
        "WebAgent executor requires a Pi-compatible model; configure a model kind such as pi-anthropic",
      )
    }

    const harness = createHarness({
      model: runtimeModel.model,
      streamFn: runtimeModel.streamFn,
      tools: toPiTools(tools),
      systemPrompt,
    })

    if (runtimeModel.getApiKey && harness.agent) {
      harness.agent.getApiKey = runtimeModel.getApiKey
    }

    return harness
  }

  async execute(srv, options, requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const controller = new AbortController()
    const sessionKey = this._sessionKey(srv, contextId)
    let harness
    let unsubscribe
    let streamed = false

    if (cds.context) {
      cds.context["agent.task.id"] = taskId
      cds.context["agent.context.id"] = contextId
      cds.context["agent.service"] = srv.name
      cds.context["agent.eventBus"] = eventBus
    }

    this._running.set(taskId, { controller })
    if (!requestContext.task) {
      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
      })
    }
    eventBus.publish(publishedStatus(taskId, contextId, "working", undefined, false))

    try {
      harness = this._sessions.get(sessionKey)
      if (!harness) {
        harness = await this._createHarness(srv, options)
        this._sessions.set(sessionKey, harness)
      }
      this._running.set(taskId, { controller, harness })

      unsubscribe = harness.agent.subscribe((event) => {
        const update = event?.assistantMessageEvent
        if (event?.type !== "message_update" || update?.type !== "text_delta" || !update.delta) {
          return
        }
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          append: streamed,
          lastChunk: false,
          artifact: { artifactId: "response", parts: [{ kind: "text", text: update.delta }] },
        })
        streamed = true
      })

      const prompt = partsToText(requestContext.userMessage?.parts)
      const output = await harness.prompt(prompt)

      if (controller.signal.aborted) throw new globalThis.DOMException("Task canceled", "AbortError")
      if (harness.state?.errorMessage) throw new Error(harness.state.errorMessage)

      eventBus.publish({
        kind: "artifact-update",
        taskId,
        contextId,
        append: false,
        lastChunk: true,
        artifact: { artifactId: "response", parts: [{ kind: "text", text: output }] },
      })
      eventBus.publish(publishedStatus(taskId, contextId, "completed", output, true))
    } catch (error) {
      const canceled = controller.signal.aborted || error?.name === "AbortError"
      const state = canceled ? "canceled" : "failed"
      const production = process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod"
      const text = canceled
        ? "Task canceled."
        : production && error?.$sanitize !== false
          ? cds.i18n.messages.at(500) || "Internal Server Error"
          : `Agent error: ${error.message}`
      if (!canceled) LOG.error("WebAgent executor failed", { service: srv.name, error: error.message })
      eventBus.publish(publishedStatus(taskId, contextId, state, text, true))
    } finally {
      if (typeof unsubscribe === "function") unsubscribe()
      this._running.delete(taskId)
      eventBus.finished()
    }
  }

  abort(taskId) {
    const running = this._running.get(taskId)
    if (!running) return
    running.controller.abort()
    running.harness?.agent?.abort?.()
  }

  async cancelTask(taskId, eventBus) {
    if (this._running.has(taskId)) return this.abort(taskId)
    eventBus.publish(publishedStatus(taskId, undefined, "canceled", "Task canceled.", true))
    eventBus.finished()
  }
}

export { WebAgentExecutor }
