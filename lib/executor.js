import cds from "@sap/cds"

const DEFAULT_EXECUTOR_IMPL = "@cap-js/agents/srv/langgraph-executor-srv"

/**
 * Resolve the A2A executor through the regular CDS requires/kinds mechanism.
 * Keeping this tiny indirection outside the protocol adapter lets alternative
 * runtimes (such as Pi) own their complete execution lifecycle.
 */
export async function createExecutor(srv) {
  const name =
    srv?.options?.agent?.executor || srv?.definition?.["@agent.executor"] || "agent-executor"
  const configured = cds.requires?.[name]
  const kind = configured?.kind
  const impl = configured?.impl || cds.requires?.kinds?.[kind]?.impl || DEFAULT_EXECUTOR_IMPL
  const module = await import(impl)
  const Executor = module.default || module.WebAgentExecutor || module.PiExecutor || module.LangGraphExecutor

  if (!Executor || typeof Executor.for !== "function") {
    throw new Error(`Agent executor "${name}" (${impl}) must export a class with static for(srv)`)
  }

  return Executor.for(srv, configured || {})
}

export { DEFAULT_EXECUTOR_IMPL }
