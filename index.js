import { CdsCheckpointSaver } from "./lib/persistence/checkpoint-saver.js"
import { CdsTaskStore } from "./lib/persistence/task-store.js"
import {
  createModel,
  createDeepAgentModel,
  flattenMessages,
  buildContentFilter,
} from "./lib/llm.js"
import { generateTools } from "./lib/tools.js"
import quotaEnforcerAtNode from "./lib/executor/langgraph/nodes/quotaEnforcerAtNode.js"
import quotaEnforcerAtStart from "./lib/executor/langgraph/nodes/quotaEnforcerAtStart.js"
import shouldContinue from "./lib/executor/langgraph/nodes/shouldContinue.js"
import { contentFilterRecoveryMiddleware } from "./lib/middlewares/content-filter-recovery.js"

/**
 * - CdsCheckpointSaver: LangGraph checkpointer backed by CDS entities (multi-turn, HITL)
 * - CdsTaskStore: A2A task persistence backed by CDS entities
 * - createModel: LLM model factory — use { deepAgent: true } for deepagents to handle
 *   array-content messages from deepagents' built-in tools that SAP AI Core would otherwise reject
 * - generateTools: Creates LangChain tools from a CDS service model (query, describe, per-action)
 */
export {
  CdsCheckpointSaver,
  CdsTaskStore,
  contentFilterRecoveryMiddleware,
  createDeepAgentModel,
  createModel,
  flattenMessages,
  buildContentFilter,
  generateTools,
}

export const nodes = {
  quotaEnforcerAtStart,
  quotaEnforcerAtNode,
  shouldContinue,
}
