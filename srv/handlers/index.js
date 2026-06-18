import cds from "@sap/cds"
import { createModel, buildContentFilter } from "./model.js"
import { generateTools } from "./tools.js"
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

  // Default buildModel: create OrchestrationClient
  srv.on("buildModel", async (req) => {
    const contentFilter = await srv.send("buildContentFilter", {})
    return createModel({ srv, ...req.data })
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
    const { instrumentTools } = await import("./tools.js")

    const tools = await srv.send("buildTools", { srv })

    // Auto-instrument tools for tracing/audit/metrics (idempotent)
    if (tools?.length > 0) instrumentTools(tools)

    // Build toolMap from tools array for createManagedAgentNodes
    const toolMap = {}
    for (const t of tools || []) toolMap[t.name] = t

    let model = await srv.send("buildModel", { srv, tools })

    // Auto-bind tools if model supports it and wasn't already bound
    if (tools?.length > 0 && typeof model.bindTools === "function" && !model.tools?.length) {
      model = model.bindTools(tools)
    }

    const systemPrompt = await srv.send("buildSystemPrompt", { srv })

    const checkpointer = new CdsCheckpointSaver()
    const agentState = await createAgentState()
    const nodes = createManagedAgentNodes(model, toolMap)
    const graph = await createAgentGraph(agentState, nodes, checkpointer)

    return new GraphExecutor(graph, srv, {
      checkpointer: false,
      inputMapper: async (requestContext) => {
        const { HumanMessage, SystemMessage } = await import("@langchain/core/messages")
        const text =
          requestContext.userMessage?.parts
            ?.filter((p) => p.kind === "text" || (!p.kind && p.text))
            .map((p) => p.text)
            .join(" ") || ""

        const config = { configurable: { thread_id: `${srv.name}:${requestContext.contextId}` } }
        const existing = await checkpointer.getTuple(config)

        if (existing) {
          return { messages: [new HumanMessage(text)] }
        }
        return { messages: [new SystemMessage(systemPrompt), new HumanMessage(text)] }
      },
    })
  })
}
