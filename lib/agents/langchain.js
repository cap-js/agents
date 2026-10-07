import cds from '@sap/cds'
import { createReadFileTool } from '../../srv/handlers/tools.js'
import { CdsCheckpointSaver } from '../../lib/protocol/persistence/checkpoint-saver.js'
import { isDeepAgentDir, resolveAgentDir } from '../../lib/utils/markdown.js'

export default async function create(srv) {
  const agentDir = resolveAgentDir(srv)

  // Auto-built deep agent from AGENTS.md + skills/ convention
  if (agentDir && isDeepAgentDir(agentDir)) {
    const { createAutoDeepAgent } = await import("../../lib/agents/markdown/deep-agent.js")
    return createAutoDeepAgent(srv, agentDir)
  }

  // Standard ReAct agent via langchain's createAgent
  const { createAgent } = await import("langchain")

  const tools = await srv.send("buildTools")

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

  return createAgent({
    model,
    tools,
    systemPrompt,
    middleware,
    checkpointer,
  }).withConfig({
    recursionLimit: cds.env.agents?.recursionLimit ?? 100
  })
}
