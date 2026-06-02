/* eslint-disable no-await-in-loop */
const { ChatAnthropic } = require("@langchain/anthropic")
/**
 * Travel Agent — Deep agent orchestrator for @cap-js/a2a.
 *
 * Coordinates downstream A2A agents (hotel, activity) and MCP servers (flights)
 * using createDeepAgent() with progressive disclosure via AGENTS.md.
 *
 * Demonstrates:
 * - Downstream A2A agent delegation (natural language tools)
 * - MCP server tool access (structured parameters)
 * - createModel({ deepAgent: true }) for AI Core compatibility
 * - CdsCheckpointSaver auto-injected by the plugin for multi-turn conversations
 */
import cds from "@sap/cds"
const { path } = cds.utils
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createDeepAgent, FilesystemBackend } from "deepagents"
import { createDeepAgentModel, contentFilterRecoveryMiddleware } from "@cap-js/a2a"

const LOG = cds.log("travel-agent")
const __agentDir = path.join(import.meta.dirname, "travel-agent")

const A2A_AGENTS = ["http://localhost:4006/a2a/hotel", "http://localhost:4006/a2a/activity"]

const MCP_SERVERS = {
  flights: { url: "http://localhost:4005/mcp/data" },
}

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
 * Create a LangChain tool that wraps an A2A client.
 */
function createA2ATool(client, agentCard) {
  const name = agentCard.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
  const skills =
    agentCard.skills?.map((s) => `  - ${s.name}: ${s.description || ""}`).join("\n") || ""
  const description = `${agentCard.description || agentCard.name}${skills ? "\nSkills:\n" + skills : ""}`

  return tool(
    async ({ message }) => {
      try {
        const result = await client.sendMessage({
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text: message }],
          },
        })
        return extractText(result)
      } catch (err) {
        LOG.warn("A2A tool error caught (deepagents workaround)", {
          agent: agentCard.name,
          error: err.message,
        })
        return `Error communicating with ${agentCard.name}: ${err.message}`
      }
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

/**
 * Connect to downstream A2A agents and MCP servers, returning tools for the deep agent.
 */
async function discoverTools() {
  const { ClientFactory } = await import("@a2a-js/sdk/client")
  const { MultiServerMCPClient } = await import("@langchain/mcp-adapters")
  const factory = new ClientFactory()

  const tools = []

  // Connect to A2A agents (natural language delegation)
  for (const url of A2A_AGENTS) {
    try {
      LOG.info("Connecting to A2A agent", { url })
      const cardRes = await fetch(`${url}/.well-known/agent-card.json`)
      if (!cardRes.ok) throw new Error(`Agent card fetch failed: ${cardRes.status}`)
      const card = await cardRes.json()
      const client = await factory.createFromAgentCard(card)
      const t = createA2ATool(client, card)
      tools.push(t)
      LOG.info("Connected to A2A agent", { agent: card.name, skills: card.skills?.length || 0 })
    } catch (err) {
      LOG.warn("Failed to connect to A2A agent", { url, error: err.message })
    }
  }

  // Connect to MCP servers (direct tool access)
  // Wrap MCP tools to catch schema validation errors — deepagents' ToolNode
  // re-throws these as MiddlewareErrors which crash graph.invoke().
  // By catching here, errors become normal tool results the LLM can learn from.
  for (const [serverName, serverConfig] of Object.entries(MCP_SERVERS)) {
    try {
      LOG.info("Connecting to MCP server", { server: serverName, url: serverConfig.url })
      const mcpClient = new MultiServerMCPClient({ mcpServers: { [serverName]: serverConfig } })
      const mcpTools = await mcpClient.getTools()
      for (const mcpTool of mcpTools) {
        const originalInvoke = mcpTool.invoke.bind(mcpTool)
        mcpTool.invoke = async (args, config) => {
          try {
            return await originalInvoke(args, config)
          } catch (err) {
            LOG.debug("MCP tool error caught (deepagents workaround)", {
              tool: mcpTool.name,
              error: err.message,
            })
            return `Error: ${err.message}`
          }
        }
      }
      tools.push(...mcpTools)
      LOG.info("Connected to MCP server", { server: serverName, tools: mcpTools.length })
    } catch (err) {
      LOG.warn("Failed to connect to MCP server", { server: serverName, error: err.message })
    }
  }

  if (tools.length === 0) {
    throw new Error(
      "No downstream agents or MCP servers available. Make sure leisure-services (4006) and xflights (4005) are running.",
    )
  }

  return tools
}

async function createTravelAgent() {
  const tools = await discoverTools()
  const model = await createDeepAgentModel()

  LOG.info("Creating travel deep agent", { tools: tools.length, agentDir: __agentDir })

  // const model = new ChatAnthropic({
  //   model: "claude-sonnet-4-5",
  //   anthropicApiKey: "<api-key>",
  //   anthropicApiUrl: "http://localhost:6655/anthropic",
  // })

  const agent = createDeepAgent({
    model,
    tools,
    memory: ["./AGENTS.md"],
    skills: ["./skills/"],
    backend: new FilesystemBackend({ rootDir: __agentDir, virtualMode: true }),
    // middleware: [await contentFilterRecoveryMiddleware()], // See below for more information
  })

  LOG.info("Travel deep agent created")
  return agent
}

export default class TravelAgentServiceHandler extends cds.ApplicationService {
  async init() {
    this.a2a = {
      graph: createTravelAgent(),
      // Deepagents accumulate large contexts (system prompt + skills + tool
      // results) that exceed Azure Content Safety prompt_shield's payload size
      // limit (surfaces as HTTP 503 + `AI-External-Failure: true`). When enabled,
      // make sure to use the `contentFilterRecoveryMiddleware` to not
      // block the agent with an error
      contentFilter: false,
    }

    this.on("plan", async () => {
      return "Please use the A2A protocol to interact with the travel agent."
    })

    await super.init()
  }
}
