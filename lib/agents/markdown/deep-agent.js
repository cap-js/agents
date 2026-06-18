import cds from "@sap/cds"
import { generateTools } from "../../../srv/handlers/tools.js"
import { contentFilterRecoveryMiddleware } from "./middlewares/content-filter-recovery.js"
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

  const tools = await generateTools(srv)
  const model = await srv.send("buildModel", { deepAgent: true, tools })

  const { createDeepAgent, FilesystemBackend } = await import("deepagents")

  LOG.debug("Auto-building deep agent", {
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
    middleware: [...(await quotaEnforcerMiddleware()), await contentFilterRecoveryMiddleware()],
    interruptOn: criticalTools.reduce((acc, tool) => {
      acc[tool.name] = { allowedDecisions: ["approve", "reject"] }
      return acc
    }, {}),
    // checkpointer auto-injected by GraphExecutor (CdsCheckpointSaver)
  })
}
