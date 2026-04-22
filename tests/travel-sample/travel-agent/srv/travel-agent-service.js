/* eslint-disable no-await-in-loop */
const cds = require("@sap/cds")
const { tool } = require("@langchain/core/tools")
const { z } = require("zod")
const { StateGraph, Annotation, messagesStateReducer } = require("@langchain/langgraph")
const { HumanMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages")
const { CdsCheckpointSaver } = require("@cap-js/a2a")

const LOG = cds.log("a2a")

// Downstream A2A agents — the orchestrator sends natural language messages
const A2A_AGENTS = ["http://localhost:4006/a2a/hotel", "http://localhost:4006/a2a/activity"]

// Downstream MCP servers — the orchestrator calls tools directly
const MCP_SERVERS = {
  flights: { url: "http://localhost:4005/mcp/data" },
}

// ── A2A Client Tool Factory ──────────────────────────────────────────

/**
 * Extract text response from an A2A sendMessage result.
 * The result can be a Task or a Message.
 */
function extractText(result) {
  if (!result) return "No response from agent."

  if (result.kind === "task") {
    const statusText = result.status?.message?.parts
      ?.filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n")
    if (statusText) return statusText

    const artifactText = result.artifacts
      ?.flatMap((a) => a.parts)
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n")
    if (artifactText) return artifactText

    return `Task ${result.id}: ${result.status?.state || "unknown"}`
  }

  if (result.kind === "message") {
    return (
      result.parts
        ?.filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join("\n") || "Empty message."
    )
  }

  return JSON.stringify(result)
}

/**
 * Build a skills summary from an agent card's skills array.
 */
function skillsSummary(agentCard) {
  if (!agentCard.skills || agentCard.skills.length === 0) return ""
  return agentCard.skills.map((s) => `  - ${s.name}: ${s.description || ""}`).join("\n")
}

/**
 * Create a LangChain tool that wraps an A2A client.
 */
function createA2ATool(client, agentCard) {
  const name = agentCard.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
  const skills = skillsSummary(agentCard)
  const description = `${agentCard.description || agentCard.name}${skills ? "\nSkills:\n" + skills : ""}`

  return tool(
    async ({ message }) => {
      const result = await client.sendMessage({
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [{ kind: "text", text: message }],
        },
      })

      return extractText(result)
    },
    {
      name,
      description,
      schema: z.object({
        message: z.string().describe("The request to send to this agent"),
      }),
    },
  )
}

// ── LangGraph State ──────────────────────────────────────────────────

const TravelState = Annotation.Root({
  input: Annotation({ reducer: (_, v) => v }),
  messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
  output: Annotation({ reducer: (_, v) => v }),
  toolCalls: Annotation({ reducer: (_, v) => v, default: () => [] }),
  iterations: Annotation({ reducer: (_, v) => v, default: () => 0 }),
})

// ── LangGraph Nodes ──────────────────────────────────────────────────

/** Collapse multi-line output into a single readable log line */
function oneline(str, max = 150) {
  const s = str
    .replace(/[\n\r]+/g, " ")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
  return s.length > max ? s.substring(0, max) + "..." : s
}

/** Format tool label for logging */
function toolLabel(name, toolMeta) {
  const meta = toolMeta?.get(name)
  if (!meta) return name
  if (meta.proto === "a2a") return `a2a:${meta.origin}`
  return `mcp:${meta.origin} > ${name}`
}

async function agentNode(state, config) {
  const { model, systemPrompt } = config.configurable

  const messages = [...state.messages]
  const newMessages = []

  // Detect whether we're inside the ReAct loop (agent → tools → agent)
  // vs starting a new user turn. ToolMessage as last message = ReAct continuation.
  const lastMsg = state.messages[state.messages.length - 1]
  const isReactLoop = lastMsg && lastMsg._getType?.() === "tool"

  if (state.messages.length === 0) {
    // First turn, first call — inject system prompt + user input
    if (systemPrompt) {
      messages.push(new SystemMessage(systemPrompt))
      newMessages.push(new SystemMessage(systemPrompt))
    }
    const humanMsg = new HumanMessage(state.input)
    messages.push(humanMsg)
    newMessages.push(humanMsg)
  } else if (!isReactLoop) {
    // Multi-turn resume — checkpointer restored history, add new user input
    const humanMsg = new HumanMessage(state.input)
    messages.push(humanMsg)
    newMessages.push(humanMsg)
  }
  // else: ReAct loop continuation — messages already has tool results, just call the LLM

  // New turn = first call ever OR multi-turn resume (not a ReAct loop continuation).
  // Reset per-turn state (iterations, output) so the agent has a fresh budget.
  const isNewTurn = !isReactLoop

  const response = await model.invoke(messages)
  const toolCalls = response.tool_calls || []
  newMessages.push(response)

  return {
    messages: newMessages,
    toolCalls,
    // New turn: always capture fresh response. ReAct loop: prefer previous output over narration.
    output:
      isNewTurn || toolCalls.length === 0 ? response.content : state.output || response.content,
    // New turn: reset iteration counter. ReAct loop: increment.
    iterations: isNewTurn ? 1 : state.iterations + 1,
  }
}

async function toolNode(state, config) {
  const { toolMap, toolMeta } = config.configurable
  const toolCalls = state.toolCalls || []

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      const t = toolMap[tc.name]
      const label = toolLabel(tc.name, toolMeta)
      if (!t) {
        LOG.warn(`  ?  [${label}] not found`)
        return new ToolMessage({
          content: `Tool "${tc.name}" not found.`,
          tool_call_id: tc.id,
        })
      }
      LOG.info(`  -> [${label}]`, oneline(JSON.stringify(tc.args)))
      try {
        const result = await t.invoke(tc.args)
        // MCP tools return [content, artifact] tuple; A2A tools return a plain string
        const content = Array.isArray(result) ? result[0] : result
        const contentStr = typeof content === "string" ? content : JSON.stringify(content)
        LOG.info(`  <- [${label}]`, `${contentStr.length}ch`, oneline(contentStr))
        return new ToolMessage({ content: contentStr, tool_call_id: tc.id })
      } catch (err) {
        LOG.error(`  x  [${label}]`, oneline(err.message))
        return new ToolMessage({ content: `Error: ${err.message}`, tool_call_id: tc.id })
      }
    }),
  )

  return { messages: results, toolCalls: [] }
}

function shouldContinue(state) {
  if (state.toolCalls && state.toolCalls.length > 0 && state.iterations < 10) {
    return "tools"
  }
  return "__end__"
}

function createTravelGraph(checkpointer) {
  return new StateGraph(TravelState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue, { tools: "tools", __end__: "__end__" })
    .addEdge("tools", "agent")
    .compile({ checkpointer })
}

// ── A2A Message Helpers ──────────────────────────────────────────────

function agentMessage(text) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text }],
  }
}

// ── Travel Agent Executor ────────────────────────────────────────────

class TravelAgentExecutor {
  constructor(srv) {
    this.srv = srv
    this._tools = null
    this._toolMap = null
    this._systemPrompt = null
    this._model = null
    this._initPromise = null
    this._checkpointer = new CdsCheckpointSaver()
    this._graph = null
  }

  async _ensureInitialized() {
    if (this._tools) return
    if (this._initPromise) return this._initPromise
    this._initPromise = this._initialize()
    return this._initPromise
  }

  async _initialize() {
    const { ClientFactory } = require("@a2a-js/sdk/client")
    const { MultiServerMCPClient } = require("@langchain/mcp-adapters")
    const factory = new ClientFactory()

    const tools = []
    const agentDescriptions = []
    const toolMeta = new Map()

    // ── Connect to A2A agents (natural language delegation) ──────────
    for (const url of A2A_AGENTS) {
      try {
        LOG.info("Connecting to A2A agent", { url })
        const cardRes = await fetch(`${url}/.well-known/agent-card.json`)
        if (!cardRes.ok) throw new Error(`Agent card fetch failed: ${cardRes.status}`)
        const card = await cardRes.json()
        const client = await factory.createFromAgentCard(card)
        const t = createA2ATool(client, card)
        tools.push(t)
        toolMeta.set(t.name, { proto: "a2a", origin: card.name })
        agentDescriptions.push(
          `- **${card.name}** (tool: \`${t.name}\`): ${card.description || ""} — send natural language requests to this A2A agent`,
        )
        LOG.info("Connected to A2A agent", { agent: card.name, skills: card.skills?.length || 0 })
      } catch (err) {
        LOG.warn("Failed to connect to A2A agent", { url, error: err.message })
      }
    }

    // ── Connect to MCP servers (direct tool access) ──────────────────
    const mcpDescriptions = []
    for (const [serverName, serverConfig] of Object.entries(MCP_SERVERS)) {
      try {
        LOG.info("Connecting to MCP server", { server: serverName, url: serverConfig.url })
        this._mcpClient = new MultiServerMCPClient({ mcpServers: { [serverName]: serverConfig } })
        const mcpTools = await this._mcpClient.getTools()
        tools.push(...mcpTools)
        for (const t of mcpTools) {
          toolMeta.set(t.name, { proto: "mcp", origin: serverName })
          mcpDescriptions.push(`- \`${t.name}\`: ${t.description || ""}`)
        }
        LOG.info("Connected to MCP server", { server: serverName, tools: mcpTools.length })
      } catch (err) {
        LOG.warn("Failed to connect to MCP server", { server: serverName, error: err.message })
      }
    }

    if (tools.length === 0) {
      throw new Error(
        "No downstream agents or MCP servers available. Make sure activities (4006) and xflights (4005) are running.",
      )
    }

    this._tools = tools
    this._toolMap = Object.fromEntries(tools.map((t) => [t.name, t]))
    this._toolMeta = toolMeta

    this._systemPrompt = [
      "You are a friendly and knowledgeable travel planning assistant.",
      "You help users plan trips by coordinating hotels, flights, and local activities.",
      "",
      "## A2A Agents (send natural language requests)",
      "These are autonomous agents with their own LLM. Send them a descriptive message and they will handle the rest:",
      "",
      ...agentDescriptions,
      "",
      "## MCP Tools (call directly with structured parameters)",
      "These are direct tools from a flight master data service. Call them with the exact parameters they expect.",
      "IMPORTANT: For MCP tools, always call `describe` first to learn the exact entity schema before constructing `where` filters. The Flights entity uses flattened field names from a joined view — do NOT guess field names.",
      "",
      ...mcpDescriptions,
      "",
      "## Guidelines",
      "- Be proactive: when a user asks to plan a trip, start searching immediately. Do NOT ask clarifying questions unless the destination is unclear.",
      "- Use reasonable defaults for missing details: pick an upcoming weekend, assume a mid-range budget, suggest popular options.",
      "- Call multiple tools in parallel when the request spans multiple domains (flights + hotels + activities).",
      "- For hotels, delegate to the hotel A2A agent with a natural language description of what you need.",
      "- For activities, delegate to the activity A2A agent with a natural language description.",
      "- For flights, first call `describe` to learn the schema, then query with correct field names. Query Airports to find airport codes for the destination city.",
      "- Present concrete options with prices and details, then help the user choose.",
      "- When the user decides, make the bookings via the A2A agents and the bookFlight MCP tool.",
      "- You can cancel flight bookings using the cancelFlight action with the booking ID.",
      "- Summarize the complete itinerary at the end.",
      "- Be concise, helpful, and enthusiastic about travel!",
      "- Do not reveal internal tool names to the user.",
    ].join("\n")

    LOG.info("Travel agent initialized", {
      a2aAgents: agentDescriptions.length,
      mcpTools: mcpDescriptions.length,
    })
  }

  async _getModel() {
    if (this._model) return this._model

    const { OrchestrationClient } = require("@sap-ai-sdk/langchain")

    const modelName = cds.env.a2a?.llm || process.env.AICORE_MODEL || "anthropic--claude-4.5-sonnet"

    LOG.info("Initializing travel agent LLM", { model: modelName })

    const client = new OrchestrationClient({
      promptTemplating: {
        model: {
          name: modelName,
          params: { max_tokens: 4096, temperature: 0 },
        },
      },
    })

    this._model = client.bindTools(this._tools)
    return this._model
  }

  async execute(requestContext, eventBus) {
    const { userMessage, taskId, contextId } = requestContext

    const text = userMessage.parts
      ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
      .map((p) => p.text)
      .join("\n")

    const publishTask = (state, message) => {
      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId,
        status: {
          state,
          ...(message && { message: agentMessage(message) }),
          timestamp: new Date().toISOString(),
        },
      })
    }

    if (!text) {
      publishTask("failed", "No text content found in message.")
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "failed",
          message: agentMessage("No text content found in message."),
          timestamp: new Date().toISOString(),
        },
        final: true,
      })
      eventBus.finished()
      return
    }

    publishTask("submitted")
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    })

    try {
      await this._ensureInitialized()
      const model = await this._getModel()

      // Compile graph once with checkpointer (lazy init)
      if (!this._graph) {
        this._graph = createTravelGraph(this._checkpointer)
      }

      LOG.info(`Planning: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`, {
        contextId,
      })
      const start = Date.now()

      const result = await this._graph.invoke(
        { input: text },
        {
          configurable: {
            thread_id: contextId,
            model,
            toolMap: this._toolMap,
            toolMeta: this._toolMeta,
            systemPrompt: this._systemPrompt,
          },
        },
      )

      const output = result.output || "No response generated."
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      LOG.info(`Planning completed (${elapsed}s)`)

      eventBus.publish({
        kind: "artifact-update",
        taskId,
        contextId,
        artifact: {
          artifactId: "response",
          name: "Travel Agent Response",
          parts: [{ kind: "text", text: output }],
        },
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
      LOG.error("Travel planning failed", { taskId, error: err.message, stack: err.stack })

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "failed",
          message: agentMessage(`Planning error: ${err.message}`),
          timestamp: new Date().toISOString(),
        },
        final: true,
      })
    }

    eventBus.finished()
  }

  async cancelTask(taskId, eventBus) {
    LOG.info("Cancelling task", { taskId })
    eventBus.publish({
      kind: "task",
      id: taskId,
      status: { state: "canceled", timestamp: new Date().toISOString() },
    })
    eventBus.publish({
      kind: "status-update",
      taskId,
      status: { state: "canceled", timestamp: new Date().toISOString() },
      final: true,
    })
    eventBus.finished()
  }
}

// ── CDS Service Handler ──────────────────────────────────────────────

module.exports = class TravelAgentServiceHandler extends cds.ApplicationService {
  async init() {
    this.a2a = { executor: new TravelAgentExecutor(this) }

    this.on("plan", async (req) => {
      return "Please use the A2A protocol to interact with the travel agent."
    })

    await super.init()
  }
}
