import cds from "@sap/cds"
import { ReadonlyBackend } from "./backends/readonly-backend.js"
const { fs, path } = cds.utils

const LOG = cds.log("agents")

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

  const {
    createDeepAgent,
    StateBackend,
    CompositeBackend,
    createMemoryMiddleware,
    createSkillsMiddleware,
  } = await import("deepagents")

  LOG.debug("Auto-building deep agent", {
    service: srv?.name,
    agentDir,
    tools: tools.length,
  })

  const additionalBackends = {}

  if (cds.env.agents?.fileIO?.enabled) {
    const { CdsFileStore } = await import("../../protocol/persistence/file-store.js")
    const { UploadsBackend } = await import("./backends/uploads-backend.js")
    const { OutputsBackend } = await import("./backends/outputs-backend.js")
    const fileStore = new CdsFileStore()
    Object.assign(additionalBackends, {
      "/uploads/": new UploadsBackend(fileStore),
      "/outputs/": new OutputsBackend(fileStore),
    })
  }

  const agentFsBackend = new ReadonlyBackend({ rootDir: agentDir, virtualMode: true })
  const agentDirMiddleware = []
  if (fs.existsSync(path.join(agentDir, "AGENTS.md"))) {
    agentDirMiddleware.push(
      createMemoryMiddleware({
        backend: agentFsBackend,
        sources: ["./AGENTS.md"],
      }),
    )
  }
  if (fs.existsSync(path.join(agentDir, "skills"))) {
    additionalBackends["./skills/"] = additionalBackends["/skills/"] = new ReadonlyBackend({
      rootDir: path.join(agentDir, "skills"),
      virtualMode: true,
    })
    agentDirMiddleware.push(
      createSkillsMiddleware({
        backend: agentFsBackend,
        sources: ["./skills"],
      }),
    )
  }

  const backend = new CompositeBackend(new StateBackend(), additionalBackends)

  return createDeepAgent({
    model,
    tools,
    systemPrompt,
    backend,
    middleware: [...agentDirMiddleware, ...middleware],
    // checkpointer auto-injected by GraphExecutor (CdsCheckpointSaver)
  })
}
