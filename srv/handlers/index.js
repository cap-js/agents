import cds from "@sap/cds"
import { generateTools, instrumentTools, createReadFileTool } from "./tools.js"
import { buildSystemPrompt } from "./system-prompt.js"
import buildMiddleware from "../../lib/agents/middleware/index.js"
import { partsToText } from "../../lib/utils/message-handling.js"

const LOG = cds.log("agent")

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
  srv.on("buildTools", async () => {
    const cdsTools = generateTools(srv)

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

    if (selected.length === 0) return cdsTools

    const mcpEntries = []
    const agentEntries = []
    for (const s of selected) {
      if (s.protocols?.agent || s["@agent"]) agentEntries.push(s.name)
      else if (s.protocols?.mcp || s["@mcp"]) mcpEntries.push(s.name)
      else LOG.warn(`Agent ${srv.name} could not connect to ${s.name}, missing @mcp or @agent`)
    }

    const { buildMcpTools } = await import("./mcp-tools.js")
    const { buildSubAgentTool } = await import("./sub-agent-tools.js")

    const results = await Promise.allSettled([
      ...mcpEntries.map((e) => buildMcpTools(e.service ?? e)),
      ...agentEntries.map((e) => buildSubAgentTool(e.service ?? e)),
    ])

    const extraTools = []
    for (const r of results) {
      // MCP connections yield an array of tools; sub-agent connections yield a
      // single tool. Normalize both so instrumentTools sees a flat tool list.
      if (r.status === "fulfilled") {
        if (Array.isArray(r.value)) extraTools.push(...r.value.filter(Boolean))
        else if (r.value) extraTools.push(r.value)
      } else LOG.warn("Failed to build external tools:", r.reason?.message ?? r.reason)
    }

    return [...cdsTools, ...extraTools]
  })

  // Auto-instrument all tools returned by buildTools (tracing, audit, metrics)
  srv.after("buildTools", (tools) => {
    if (Array.isArray(tools) && tools.length > 0) {
      instrumentTools(tools)
    }
    return tools
  })

  // Default buildModel: cds.connect.to('llm'), configurable via @agent.llm
  srv.on("buildModel", async (req) => {
    const name = srv?.options?.agent?.llm || srv?.definition?.["@agent.llm"] || "llm"
    let { kind, impl, ...options } = cds.requires[name] ?? {}
    if (!impl) impl = cds.requires.kinds[kind]?.impl
    if (!impl) throw new Error("No service implementation found for " + name)
    const { default: LLMProvider } = await import(impl)
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

  // Default buildGraph: if agent dir with AGENTS.md exists → auto-build deep agent.
  // Otherwise orchestrates sub-events → wires ReAct agent via langchain's createAgent.
  srv.on("buildGraph", async () => {
    const { resolveAgentDir, isDeepAgentDir } = await import("../../lib/utils/markdown.js")
    const agentDir = resolveAgentDir(srv)

    // Auto-built deep agent from AGENTS.md + skills/ convention
    if (agentDir && isDeepAgentDir(agentDir)) {
      const { createAutoDeepAgent } = await import("../../lib/agents/markdown/deep-agent.js")
      return createAutoDeepAgent(srv, agentDir)
    }

    // Standard ReAct agent via langchain's createAgent
    const { createAgent } = await import("langchain")
    const { CdsCheckpointSaver } =
      await import("../../lib/protocol/persistence/checkpoint-saver.js")
    const { GraphExecutor } = await import("./graph-executor.js")

    const tools = await srv.send("buildTools")

    // Ensure all tools are instrumented (idempotent — after handler covers event path,
    // this covers tools added by custom buildGraph handlers outside the event)
    if (tools?.length > 0) instrumentTools(tools)

    // File-IO: add a read_file tool that resolves context at invocation time.
    // cds.context["agent.context.id"] and user.id are set by GraphExecutor before invoke.
    if (cds.env.agents?.fileIO?.enabled) {
      const { CdsFileStore } = await import("../../lib/protocol/persistence/file-store.js")
      const fileStore = new CdsFileStore()
      const readFileTool = createReadFileTool(fileStore)
      tools.push(readFileTool)
    }

    let model = await srv.send("buildModel", { tools })

    const systemPrompt = await srv.send("buildSystemPrompt")
    const middleware = await srv.send("buildMiddleware", { tools, model })

    const checkpointer = new CdsCheckpointSaver()

    const agent = createAgent({
      model,
      tools,
      systemPrompt,
      middleware,
      checkpointer,
    })

    return new GraphExecutor(agent, srv, {
      checkpointer: false, // already set on createAgent
      // Standard ReAct agents have no built-in recursionLimit default (LangGraph's
      // fallback is 25, which is too low for multi-tool tasks). Deep agents go through
      // langgraph-executor-srv.js which passes no recursionLimit → deepagents' 10000 wins.
      recursionLimit: cds.env.agents?.recursionLimit ?? 100,
      inputMapper: async (requestContext) => {
        const { HumanMessage } = await import("@langchain/core/messages")
        const text = partsToText(requestContext.userMessage?.parts)

        // Append file manifest injected by GraphExecutor.execute() (fileIO path)
        const fullText = requestContext._fileManifest
          ? `${text}\n${requestContext._fileManifest}`
          : text

        return { messages: [new HumanMessage(fullText)] }
      },
    })
  })
}
