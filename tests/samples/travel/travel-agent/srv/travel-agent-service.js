/* eslint-disable no-await-in-loop */
/**
 * Travel Agent — Deep agent orchestrator for @cap-js/agents.
 *
 * Coordinates downstream A2A agents (hotel, activity) and MCP servers (flights)
 * via the plugin's auto-build path: AGENTS.md + skills/ are wired into a
 * deepagents graph by plugin.
 *
 * Demonstrates:
 * - buildTools event to discover downstream A2A agents and MCP servers
 * - buildContentFilter event to disable filter (large contexts)
 */
import cds from "@sap/cds"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

const LOG = cds.log("travel-agent")

const A2A_AGENTS = ["http://localhost:4006/a2a/hotel", "http://localhost:4006/a2a/activity"]

const MCP_SERVERS = {
  flights: {
    url: "http://localhost:4005/mcp/data",
    transport: "http",
  },
}

/**
 * Extract text and file parts from an A2A response (task or message).
 *
 * Downstream agents may return FileParts in their responses. Surfacing them
 * here lets createA2ATool serialize them as {"kind":"file",...} JSON in the
 * tool result string so GraphExecutor's Source-1 collection loop picks them
 * up and propagates them to the caller.
 */
function extractResult(result) {
  if (!result) return { text: "No response from agent.", files: [] }

  const text = []
  const files = []

  const processParts = (parts = []) => {
    for (const part of parts) {
      if (part.kind === "text") text.push(part.text)
      else if (part.kind === "file") files.push(part)
    }
  }

  if (result.kind === "task") {
    processParts(result.status?.message?.parts)
    for (const artifact of result.artifacts || []) processParts(artifact.parts)
    if (text.length === 0 && files.length === 0) {
      return { text: `Task ${result.id}: ${result.status?.state || "unknown"}`, files: [] }
    }
  } else if (result.kind === "message") {
    processParts(result.parts)
  } else {
    return { text: JSON.stringify(result), files: [] }
  }

  return { text: text.join("\n") || "No response.", files }
}

/**
 * Wrap an A2A client as a LangChain tool the deep agent can call.
 */
function createA2ATool(client, agentCard) {
  const name = agentCard.name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .toLowerCase()
    .slice(0, 60)
  const skills = agentCard.skills?.map((s) => `- ${s.name}: ${s.description}`).join("\n") || ""
  const description = `Delegate to the "${agentCard.name}" agent. ${agentCard.description || ""}\n\nSkills:\n${skills}`

  return tool(
    async ({ message }) => {
      try {
        const result = await client.sendMessage({
          message: {
            kind: "message",
            role: "user",
            messageId: cds.utils.uuid(),
            parts: [{ kind: "text", text: message }],
          },
        })
        const { text, files } = extractResult(result)
        if (files.length === 0) return text
        // Serialize FileParts into the tool result string so the executor's
        // Source-1 collection loop picks them up as {"kind":"file",...} objects.
        const fileJson = files.map((f) => JSON.stringify({ kind: "file", file: f.file })).join("\n")
        const manifest = files
          .filter((f) => f.file?.bytes)
          .map((f) => `/uploads/${f.file.name} (${f.file.mimeType})`)
        const manifestNote = manifest.length
          ? `\n[Files from downstream agent: ${manifest.join(", ")}]`
          : ""
        return `${text}${manifestNote}\n${fileJson}`
      } catch (err) {
        LOG.warn("A2A tool error", { agent: agentCard.name, error: err.message })
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

async function discoverTools() {
  const { ClientFactory } = await import("@a2a-js/sdk/client")
  const { MultiServerMCPClient } = await import("@langchain/mcp-adapters")
  const factory = new ClientFactory()

  const a2aTools = await Promise.all(
    A2A_AGENTS.map(async (url) => {
      try {
        LOG.info("Connecting to A2A agent", { url })
        const cardRes = await fetch(`${url}/.well-known/agent-card.json`)
        if (!cardRes.ok) throw new Error(`Agent card fetch failed: ${cardRes.status}`)
        const card = await cardRes.json()
        const client = await factory.createFromAgentCard(card)
        LOG.info("Connected to A2A agent", { agent: card.name })
        return createA2ATool(client, card)
      } catch (err) {
        LOG.warn("Failed to connect to A2A agent", { url, error: err.message })
        return null
      }
    }),
  )

  const mcpToolsets = await Promise.all(
    Object.entries(MCP_SERVERS).map(async ([serverName, serverConfig]) => {
      try {
        LOG.info("Connecting to MCP server", { server: serverName })
        const mcpClient = new MultiServerMCPClient({ mcpServers: { [serverName]: serverConfig } })
        const mcpTools = await mcpClient.getTools()
        for (const mcpTool of mcpTools) {
          // Wrap to catch schema validation errors — deepagents' ToolNode re-throws
          // these as MiddlewareErrors which crash graph.invoke(). Catching here
          // turns errors into normal tool results the LLM can learn from.
          const tracedInvoke = mcpTool.invoke.bind(mcpTool)
          mcpTool.invoke = async (args, config) => {
            try {
              return await tracedInvoke(args, config)
            } catch (err) {
              LOG.debug("MCP tool error caught", { tool: mcpTool.name, error: err.message })
              return `Error: ${err.message}`
            }
          }
        }
        LOG.info("Connected to MCP server", { server: serverName, tools: mcpTools.length })
        return mcpTools
      } catch (err) {
        LOG.warn("Failed to connect to MCP server", { server: serverName, error: err.message })
        return []
      }
    }),
  )

  const tools = [...a2aTools.filter(Boolean), ...mcpToolsets.flat()]

  if (tools.length === 0) {
    throw new Error(
      "No downstream agents or MCP servers available. Make sure leisure-services (4006) and xflights (4005) are running.",
    )
  }

  return tools
}

export default class TravelAgentServiceHandler extends cds.ApplicationService {
  async init() {
    // Override buildTools: discover downstream A2A agents and MCP servers
    this.on("buildTools", () => discoverTools())

    await super.init()
  }
}
