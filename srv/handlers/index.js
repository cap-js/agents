import cds from "@sap/cds"
import { generateTools, toPiTools } from "./tools.js"
import { buildSystemPrompt } from "./system-prompt.js"
import buildMiddleware from "../../lib/agents/middleware/index.js"
import { cleanupExpiredTasks } from "../../lib/protocol/persistence/cleanup.js"
import { registerChat } from "./chat.js"
import { effectiveDefinition } from "../../lib/utils/utils.js"
import agents from '../../lib/agents/index.js'

const LOG = cds.log("agents")

/**
 * Register default event handlers for agent graph building on an @agent service.
 *
 * Apps override by registering their own handlers in init() — FIFO semantics
 * give app handlers (registered first) priority over these defaults.
 */
export default function registerDefaultAgentHandlers(srv) {
  // Default buildTools: generate tools from CDS model + any configured MCP connections.
  // MCP connections are declared via @agent.mcps annotation on the service:
  //   @agent.mcps: [{ service: 'MyConnection' }, { service: 'AnotherConnection' }]
  // Each service name must be defined as a cds.requires entry in package.json.
  srv.on("buildTools", async (req) => {
    const cdsTools = generateTools(srv)
    const extraTools = await mcpAndSubagents(srv)
    const tools = [...cdsTools, ...extraTools]
    return req.data.harness === 'pi' ? toPiTools(tools) : tools // REVISIT
  })

  // REVISIT: proper place for this
  async function mcpAndSubagents(srv) {
    // ── MCP servers and subagents ────────────────────────────────────────────────────────
    // Connect to other @mcp services and @agent services
    function canConnect(s) {
      return (
        s.name !== srv.name && (s.protocols?.mcp || s["@mcp"] || s.protocols?.agent || s["@agent"])
      )
    }

    const connect =
      srv.options?.agent?.connect ?? srv.definition["@agent.connect"] ?? cds.env.agents?.connect

    // Allow for providing an mcp or a2a connection with cds.requires only -> no cds.model.services entry
    // REVISIT: better method?
    const additionalServices = Object.entries(cds.env.requires).map(([name, s]) => ({
      name,
      kind: s?.kind,
      protocols: { [s?.kind]: true },
    }))

    const serviceMap = Object.fromEntries(
      [...additionalServices, ...(cds.model?.services ?? [])].map((s) => [s.name, s]),
    )
    const services = Object.values(serviceMap)
    const selected =
      connect === "none"
        ? []
        : connect === "auto"
          ? services?.filter(canConnect)
          : connect === "mcp"
            ? services?.filter((s) => s.name !== srv.name && (s.protocols?.mcp || s["@mcp"]))
            : connect === "agent"
              ? services?.filter((s) => s.name !== srv.name && (s.protocols?.agent || s["@agent"]))
              : connect?.map((name) => serviceMap[name]).filter(Boolean) || []

    if (selected.length === 0) return []

    const mcpEntries = []
    const agentEntries = []
    for (const s of selected) {
      if (s.protocols?.agent || s["@agent"]) agentEntries.push(s.name)
      else if (s.protocols?.mcp || s["@mcp"]) mcpEntries.push(s.name)
      else LOG.warn(`Agent ${srv.name} could not connect to ${s.name}, missing @mcp or @agent`)
    }

    const { buildMcpTools } = await import("./mcp-tools.js")
    const { buildSubAgentTool } = await import("./subagent-tools.js")

    const results = await Promise.allSettled([
      ...mcpEntries.map((e) => buildMcpTools(e.service ?? e)),
      ...agentEntries.map((e) => buildSubAgentTool(e.service ?? e)),
    ])

    const extraTools = []
    for (const r of results) {
      // MCP connections yield an array of tools; subagent connections yield a
      // single tool. Normalize both so instrumentTools sees a flat tool list.
      if (r.status === "fulfilled") {
        if (Array.isArray(r.value)) extraTools.push(...r.value.filter(Boolean))
        else if (r.value) extraTools.push(r.value)
      } else LOG.warn("Failed to build external tools:", r.reason?.message ?? r.reason)
    }

    return extraTools
  }

  // Default buildModel: cds.connect.to('llm'), configurable via @agent.llm
  srv.on("buildModel", async (req) => {
    const def = effectiveDefinition(srv)
    const name = def?.["@agent.llm"] || srv?.options?.agent?.llm || "llm"
    const options = cds.requires[name] ?? {}
    let { kind, impl } = options
    if (req.data.harness === 'pi') impl = "@cap-js/agents/lib/models/pi-generic" // REVISIT
    if (!impl) impl = cds.requires.kinds[kind]?.impl
    if (!impl) throw new Error("No service implementation found for " + name)
    const { default: LLMProvider } = await import(impl)
    const { credentials, ...o } = options
    if (credentials) o.credentials = '{ *** }'
    LOG.debug (`Creating LLMProvider instance for cds.requires.${name} with options:`, o)
    return new LLMProvider(name, { ...options, ...req.data })
  })

  // Default buildSystemPrompt: build from service definition
  srv.on("buildSystemPrompt", async () => {
    return buildSystemPrompt(srv)
  })

  // Default buildMiddleware: quota enforcement, content filtering, agent_actions metric
  srv.on("buildMiddleware", async (req) => {
    return buildMiddleware(srv, req.data)
  })

  // Default buildGraph: selects the harness (langchain / deepagents / pi) and builds the model, tool and agent for it
  srv.on("buildGraph", async () => {
    return agents.for(srv)
  })

  srv.on("cleanupTasks", async () => {
    await cleanupExpiredTasks(srv.name)
  })

  registerChat(srv)
}
