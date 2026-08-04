import cds from "@sap/cds"

const LOG = cds.log("agent")

/**
 * Auto-build a `deepagents` graph from the convention-resolved agent directory.
 */
export async function createAutoDeepAgent(srv, agentDir) {
  if (!agentDir) {
    throw new Error(
      `createAutoDeepAgent: agentDir is required (service: ${srv?.name ?? "<unknown>"})`,
    )
  }

  const tools = await srv.send("buildTools")
  const model = await srv.send("buildModel", { deepAgent: true, tools })
  const middleware = await srv.send("buildMiddleware", { model, tools })
  const systemPrompt = await srv.send("buildSystemPrompt")

  const { createDeepAgent, StateBackend, CompositeBackend } = await import("deepagents")

  LOG.debug("Auto-building deep agent", {
    service: srv?.name,
    agentDir,
    tools: tools.length,
  })

  let backend
  if (cds.env.agents?.fileIO?.enabled) {
    const { CdsFileStore } = await import("../../protocol/persistence/file-store.js")
    const { UploadsBackend } = await import("./backends/uploads-backend.js")
    const { OutputsBackend } = await import("./backends/outputs-backend.js")
    const fileStore = new CdsFileStore()
    backend = (runtime) => {
      const rawThreadId = runtime?.configurable?.thread_id || ""
      const contextId = rawThreadId.includes(":")
        ? rawThreadId.split(":").slice(1).join(":")
        : rawThreadId
      const taskId = runtime?.configurable?._taskId || ""
      // GraphExecutor threads the request-entry user id as `_userId` so the
      // backend keeps user isolation even if cds.context drifts inside the
      // agent's tool callbacks. Falls back to cds.context for compatibility.
      const userId = runtime?.configurable?._userId
      return new CompositeBackend(
        new StateBackend(),
        {
          "/uploads/": new UploadsBackend(contextId, fileStore, userId),
          "/outputs/": new OutputsBackend(taskId, fileStore),
        },
        // Fallback to StateBackend for any other paths so deepagents'
        // built-in tools that read state still work.
      )
    }
  } else {
    backend = new StateBackend()
  }

  return createDeepAgent({
    model,
    tools,
    systemPrompt,
    memory: ["./AGENTS.md"],
    skills: ["./skills/"],
    backend,
    middleware,
    // checkpointer auto-injected by GraphExecutor (CdsCheckpointSaver)
  })
}
