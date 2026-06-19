import cds from "@sap/cds"
import { createModel, buildContentFilter } from "./model.js"
import { generateTools, instrumentTools, createReadFileTool } from "./tools.js"
import { buildSystemPrompt } from "./system-prompt.js"

/**
 * Register default event handlers for agent graph building on an @agent service.
 *
 * Apps override by registering their own handlers in init() — FIFO semantics
 * give app handlers (registered first) priority over these defaults.
 */
export default function registerDefaultAgentHandlers(srv) {
  // Default buildContentFilter: resolve from cds.env.a2a.contentFilter
  srv.on("buildContentFilter", async () => {
    return buildContentFilter()
  })

  // Default buildTools: generate tools from CDS model (returns array)
  srv.on("buildTools", () => {
    return generateTools(srv)
  })

  // Auto-instrument all tools returned by buildTools (tracing, audit, metrics)
  srv.after("buildTools", (tools) => {
    if (Array.isArray(tools) && tools.length > 0) {
      instrumentTools(tools)
    }
    return tools
  })

  // Default buildModel: create OrchestrationClient.
  // Resolve contentFilter via event so user-registered buildContentFilter handlers
  // (FIFO override pattern) participate — createModel's internal fallback would
  // bypass them since it calls the imported function directly.
  srv.on("buildModel", async (req) => {
    const contentFilter = await srv.send("buildContentFilter", {})
    return createModel({ srv, contentFilter, ...req.data })
  })

  // Default buildSystemPrompt: build from service definition
  srv.on("buildSystemPrompt", async () => {
    return buildSystemPrompt(srv)
  })

  // Default buildGraph: if agent dir with AGENTS.md exists → auto-build deep agent.
  // Otherwise orchestrates sub-events → wires ReAct graph.
  srv.on("buildGraph", async () => {
    const { resolveAgentDir, isDeepAgentDir } = await import("../../lib/utils/markdown.js")
    const agentDir = resolveAgentDir(srv)

    // Auto-built deep agent from AGENTS.md + skills/ convention
    if (agentDir && isDeepAgentDir(agentDir)) {
      const { createAutoDeepAgent } = await import("../../lib/agents/markdown/deep-agent.js")
      return createAutoDeepAgent(srv, agentDir)
    }

    // Standard ReAct graph
    const { CdsCheckpointSaver } =
      await import("../../lib/protocol/persistence/checkpoint-saver.js")
    const { createAgentState } = await import("../../lib/agents/react/state.js")
    const { createManagedAgentNodes } = await import("../../lib/agents/react/nodes/index.js")
    const { createAgentGraph } = await import("../../lib/agents/react/graph.js")
    const { GraphExecutor } = await import("./graph-executor.js")

    const tools = await srv.send("buildTools")

    // Ensure all tools are instrumented (idempotent — after handler covers event path,
    // this covers tools added by custom buildGraph handlers outside the event)
    if (tools?.length > 0) instrumentTools(tools)

    // File-IO: add a static read_file tool so the bound model knows its schema.
    // The per-request implementation (contextId-scoped, with real fileStore) is
    // injected via _toolMapOverride from the configMapper below.
    let fileStore
    if (cds.env.agents?.fileIO?.enabled) {
      const { CdsFileStore } = await import("../../lib/protocol/persistence/file-store.js")
      fileStore = new CdsFileStore()
      const staticReadFile = createReadFileTool(null, "_static_")
      tools.push(staticReadFile)
    }

    // Build toolMap from tools array for createManagedAgentNodes
    const toolMap = {}
    for (const t of tools || []) toolMap[t.name] = t

    let model = await srv.send("buildModel", { tools })

    // Auto-bind tools if model supports it and wasn't already bound
    if (tools?.length > 0 && typeof model.bindTools === "function" && !model.tools?.length) {
      model = model.bindTools(tools)
    }

    const systemPrompt = await srv.send("buildSystemPrompt")

    const checkpointer = new CdsCheckpointSaver()
    const agentState = await createAgentState()
    const nodes = createManagedAgentNodes(model, toolMap)
    const graph = await createAgentGraph(agentState, nodes, checkpointer)

    return new GraphExecutor(graph, srv, {
      checkpointer: false,
      // configMapper runs on every invocation (fresh + HITL resume) — used to
      // inject the contextId-scoped read_file tool when fileIO is enabled. The
      // userId is captured here while cds.context is reliable; reading it later
      // inside the LangGraph tool node is unsafe (AsyncLocalStorage drift).
      configMapper: (requestContext) => {
        if (!fileStore || !requestContext.contextId) return {}
        const userId = cds.context?.user?.id
        return {
          _toolMapOverride: {
            read_file: createReadFileTool(fileStore, requestContext.contextId, userId),
          },
        }
      },
      inputMapper: async (requestContext) => {
        const { HumanMessage, SystemMessage } = await import("@langchain/core/messages")
        const text =
          requestContext.userMessage?.parts
            ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
            .map((p) => p.text)
            .join(" ") || ""

        // Append file manifest injected by GraphExecutor.execute() (fileIO path)
        const fullText = requestContext._fileManifest
          ? `${text}\n${requestContext._fileManifest}`
          : text

        const config = { configurable: { thread_id: `${srv.name}:${requestContext.contextId}` } }
        const existing = await checkpointer.getTuple(config)

        if (existing) {
          return { messages: [new HumanMessage(fullText)] }
        }
        return { messages: [new SystemMessage(systemPrompt), new HumanMessage(fullText)] }
      },
    })
  })
}
