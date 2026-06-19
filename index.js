import { CdsCheckpointSaver } from "./lib/protocol/persistence/checkpoint-saver.js"
import { CdsTaskStore } from "./lib/protocol/persistence/task-store.js"
import { createModel, flattenMessages, buildContentFilter } from "./srv/handlers/model.js"
import { generateTools, instrumentTool, instrumentTools } from "./srv/handlers/tools.js"
import quotaEnforcerAtNode from "./lib/agents/react/nodes/quotaEnforcerAtNode.js"
import quotaEnforcerAtStart from "./lib/agents/react/nodes/quotaEnforcerAtStart.js"
import shouldContinue from "./lib/agents/react/nodes/shouldContinue.js"
import { contentFilterRecoveryMiddleware } from "./lib/agents/markdown/middlewares/content-filter-recovery.js"
import { quotaEnforcerMiddleware } from "./lib/agents/markdown/middlewares/quota-enforcer.js"

/**
 * - CdsCheckpointSaver: LangGraph checkpointer backed by CDS entities (multi-turn, HITL)
 * - CdsTaskStore: A2A task persistence backed by CDS entities
 * - createModel: LLM model factory — use { deepAgent: true } for deepagents to handle
 *   array-content messages from deepagents' built-in tools that SAP AI Core would otherwise reject
 * - generateTools: Creates LangChain tools from a CDS service model (query, describe, per-action)
 * - instrumentTool / instrumentTools: Wrap custom tools with tracing, audit, and metrics
 */
export {
  CdsCheckpointSaver,
  CdsTaskStore,
  contentFilterRecoveryMiddleware,
  createModel,
  flattenMessages,
  buildContentFilter,
  generateTools,
  instrumentTool,
  instrumentTools,
  quotaEnforcerMiddleware,
}

export const nodes = {
  quotaEnforcerAtStart,
  quotaEnforcerAtNode,
  shouldContinue,
}
