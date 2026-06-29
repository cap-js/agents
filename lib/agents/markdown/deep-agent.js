import cds from "@sap/cds"
import { contentFilterMiddleware } from "./middlewares/content-filter.js"
import { quotaEnforcerMiddleware } from "./middlewares/quota-enforcer.js"

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

  const { createDeepAgent, FilesystemBackend, CompositeBackend } = await import("deepagents")

  LOG.debug("Auto-building deep agent", {
    service: srv?.name,
    agentDir,
    tools: tools.length,
  })

  const criticalTools = tools.filter((tool) => srv.actions[tool.name]?.["@UI.IsActionCritical"])

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
        new FilesystemBackend({ rootDir: agentDir, virtualMode: true }),
        {
          "/uploads/": new UploadsBackend(contextId, fileStore, userId),
          "/outputs/": new OutputsBackend(taskId, fileStore),
        },
        // Fallback to StateBackend for any other paths so deepagents'
        // built-in tools that read state still work.
      )
    }
  } else {
    backend = new FilesystemBackend({ rootDir: agentDir, virtualMode: true })
  }

  return createDeepAgent({
    model,
    tools,
    memory: ["./AGENTS.md"],
    skills: ["./skills/"],
    backend,
    middleware: [...(await quotaEnforcerMiddleware()), await contentFilterMiddleware()],
    interruptOn: criticalTools.reduce((acc, tool) => {
      acc[tool.name] = { allowedDecisions: ["approve", "reject"] }
      return acc
    }, {}),
    // checkpointer auto-injected by GraphExecutor (CdsCheckpointSaver)
  })
}
