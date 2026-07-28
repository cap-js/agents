import cds from "@sap/cds"
import { createModel } from "./model.js"
import { buildContentFilter } from "./content-filter.js"
import { generateTools, instrumentTools, createReadFileTool } from "./tools.js"
import { buildSystemPrompt } from "./system-prompt.js"
import buildMiddleware from "../../lib/agents/middleware/index.js"

/**
 * Register default event handlers for agent graph building on an @agent service.
 *
 * Apps override by registering their own handlers in init() — FIFO semantics
 * give app handlers (registered first) priority over these defaults.
 */
export default function registerDefaultAgentHandlers(srv) {
  // Default buildContentFilter: resolve from cds.env.agents.contentFilter
  srv.on("buildContentFilter", () => {
    return buildContentFilter()
  })

  // Default buildTools: generate tools from CDS model + any configured MCP connections.
  // MCP connections are declared via @agent.mcps annotation on the service:
  //   @agent.mcps: [{ service: 'MyConnection' }, { service: 'AnotherConnection' }]
  // Each service name must be defined as a cds.requires entry in package.json.
  srv.on("buildTools", async () => {
    const cdsTools = generateTools(srv)

    const def = cds.context?.model?.definitions?.[srv.name] || srv.definition
    const mcpEntries = def?.["@agent.mcps"] ?? []

    if (mcpEntries.length === 0) return cdsTools

    const { buildMcpToolsFromConnection } = await import("./mcp-tools.js")
    const mcpTools = (
      await Promise.all(mcpEntries.map((entry) => buildMcpToolsFromConnection(entry.service)))
    ).flat()

    return [...cdsTools, ...mcpTools]
  })

  // Auto-instrument all tools returned by buildTools (tracing, audit, metrics)
  srv.after("buildTools", (tools) => {
    if (Array.isArray(tools) && tools.length > 0) {
      instrumentTools(tools)
    }
    return tools
  })

  // Default buildModel: create OrchestrationClient
  srv.on("buildModel", async (req) => {
    return createModel({ srv, ...req.data })
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
    const middleware = await srv.send("buildMiddleware", { tools })

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
        const text =
          requestContext.userMessage?.parts
            ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
            .map((p) => p.text)
            .join(" ") || ""

        // Append file manifest injected by GraphExecutor.execute() (fileIO path)
        const fullText = requestContext._fileManifest
          ? `${text}\n${requestContext._fileManifest}`
          : text

        return { messages: [new HumanMessage(fullText)] }
      },
    })
  })
}
