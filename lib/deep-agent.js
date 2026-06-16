import cds from "@sap/cds"
import { resolveTools } from "./tools.js"
import { createDeepAgentModel } from "./llm.js"
import { contentFilterRecoveryMiddleware } from "./middlewares/content-filter-recovery.js"

const LOG = cds.log("a2a")

/**
 * Auto-build a `deepagents` graph from the convention-resolved agent directory.
 */
export async function createAutoDeepAgent(srv, agentDir) {
  if (!agentDir) {
    throw new Error(
      `createAutoDeepAgent: agentDir is required (service: ${srv?.name ?? "<unknown>"})`,
    )
  }

  const { tools } = await resolveTools(srv)
  const model = await createDeepAgentModel({ srv })

  const { createDeepAgent, FilesystemBackend } = await import("deepagents")

  LOG.info("Auto-building deep agent", {
    service: srv?.name,
    agentDir,
    tools: tools.length,
  })

  const criticalTools = tools.filter((tool) => srv.actions[tool.name]?.["@UI.IsActionCritical"])

  return createDeepAgent({
    model,
    tools,
    memory: ["./AGENTS.md"],
    skills: ["./skills/"],
    backend: new FilesystemBackend({ rootDir: agentDir, virtualMode: true }),
    middleware: [await contentFilterRecoveryMiddleware()],
    interruptOn: criticalTools.reduce((acc, tool) => {
      acc[tool.name] = { allowedDecisions: ["approve", "reject"] }
      return acc
    }, {}),
    // checkpointer auto-injected by GraphExecutor (CdsCheckpointSaver)
  })
}
