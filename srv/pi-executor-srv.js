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

function configuredLlm(srv) {
  const name = srv?.options?.agent?.llm || srv?.definition?.["@agent.llm"] || "llm"
  const config = cds.requires?.[name]
  if (!config) throw new Error(`No model configuration found in cds.requires.${name}`)

  const kind = config.kind || name
  const provider = config.provider || kind.replace(/^llm-/, "")
  const credentials = config.credentials || {}
  const model =
    config.model ||
    config.modelName ||
    credentials.model ||
    (provider === "anthropic"
      ? process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
      : provider === "mock"
        ? "mock"
        : undefined)

  if (!model) {
    throw new Error(
      `Pi requires a model in cds.requires.${name}.model (resolved provider: ${provider})`,
    )
  }

  return {
    name,
    provider,
    model,
    apiKey:
      config.apiKey ||
      credentials.apiKey ||
      credentials.anthropicApiKey ||
      (provider === "anthropic" ? process.env.ANTHROPIC_AUTH_TOKEN : undefined) ||
      process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`],
    baseUrl:
      config.baseUrl ||
      config.apiUrl ||
      config.anthropicApiUrl ||
      credentials.baseUrl ||
      credentials.url,
    headers: config.headers || credentials.headers,
    message: config.message || credentials.message,
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

async function defaultRuntime(llm) {
  const { Agent } = await import("@earendil-works/pi-agent-core")

  if (llm.provider === "mock") {
    const [{ createModels }, { fauxAssistantMessage, fauxProvider }] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/providers/faux"),
    ])
    const faux = fauxProvider({ provider: "mock", models: [{ id: llm.model }] })
    const response = () => {
      faux.appendResponses([response])
      return fauxAssistantMessage(
        llm.message ||
          "[Mock LLM] This is a mocked response from @cap-js/agents development mode. No real LLM was invoked.",
      )
    }
    faux.setResponses([response])
    const models = createModels()
    models.setProvider(faux.provider)
    return { Agent, models }
  }

  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all")
  return { Agent, models: builtinModels() }
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
    const llm = configuredLlm(srv)
    const [{ Agent, models }, tools, systemPrompt] = await Promise.all([
      this.constructor.runtime(llm),
      srv.send("buildTools"),
      srv.send("buildSystemPrompt"),
    ])
    const catalogModel = models.getModel(llm.provider, llm.model)
    if (!catalogModel) {
      throw new Error(`Pi does not know model "${llm.provider}/${llm.model}"`)
    }

    const model = { ...catalogModel }
    if (llm.baseUrl) model.baseUrl = llm.baseUrl
    if (llm.headers) model.headers = { ...model.headers, ...llm.headers }

    return new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: options.thinkingLevel || "off",
        tools: toPiTools(tools),
        messages: [],
      },
      streamFn: models.streamSimple.bind(models),
      ...(llm.apiKey && { getApiKey: async () => llm.apiKey }),
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
      if (controller.signal.aborted) throw new DOMException("Task canceled", "AbortError")
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

export { PiExecutor, configuredLlm, assistantText, publishedStatus }
