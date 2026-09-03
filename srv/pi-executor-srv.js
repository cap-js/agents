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

function publishedStatus(taskId, contextId, state, text, final) {
  return {
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state,
      ...(text && { message: agentMessage(text) }),
      timestamp: new Date().toISOString(),
    },
    final,
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
    .filter(
      (tool) =>
        tool &&
        tool.name &&
        typeof tool.invoke === "function" &&
        (typeof tool.isAllowed !== "function" || tool.isAllowed()),
    )
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

function assistantText(message) {
  if (!message || message.role !== "assistant") return ""
  if (typeof message.content === "string") return message.content
  return (message.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("")
}

async function defaultRuntime() {
  const { Agent } = await import("@earendil-works/pi-agent-core")
  return { Agent }
}

/**
 * A Pi-native A2A executor. It intentionally does not construct or invoke a
 * LangGraph; only the existing CDS tool definitions are adapted and reused.
 */
export default class PiExecutor {
  static _instance
  static runtime = defaultRuntime

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
    const [{ Agent }, runtimeModel, tools, systemPrompt] = await Promise.all([
      this.constructor.runtime(),
      srv.send("buildModel"),
      srv.send("buildTools"),
      srv.send("buildSystemPrompt"),
    ])
    if (!runtimeModel?.model || typeof runtimeModel.streamFn !== "function") {
      throw new Error(
        "Pi models must expose a model and streamFn; configure a Pi model kind such as pi-anthropic",
      )
    }

    return new Agent({
      initialState: {
        systemPrompt,
        model: runtimeModel.model,
        thinkingLevel: options.thinkingLevel || "off",
        tools: toPiTools(tools),
        messages: [],
      },
      streamFn: runtimeModel.streamFn,
      ...(runtimeModel.getApiKey && { getApiKey: runtimeModel.getApiKey }),
    })
  }

  async execute(srv, options, requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const controller = new AbortController()
    const sessionKey = this._sessionKey(srv, contextId)
    let agent
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
      await agent.prompt(prompt)
      if (controller.signal.aborted) throw new globalThis.DOMException("Task canceled", "AbortError")
      if (agent.state?.errorMessage) throw new Error(agent.state.errorMessage)

      const messages = agent.state?.messages || []
      const output = [...messages].reverse().map(assistantText).find(Boolean) || ""
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
      if (!canceled) LOG.error("Pi agent failed", { service: srv.name, error: error.message })
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
    running.agent?.abort?.()
  }

  async cancelTask(taskId, eventBus) {
    if (this._running.has(taskId)) return this.abort(taskId)
    eventBus.publish(publishedStatus(taskId, undefined, "canceled", "Task canceled.", true))
    eventBus.finished()
  }
}

export { PiExecutor, assistantText, publishedStatus }
