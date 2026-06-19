import { CdsCheckpointSaver } from "./lib/protocol/persistence/checkpoint-saver.js"
import { CdsTaskStore } from "./lib/protocol/persistence/task-store.js"
import { flattenMessages } from "./srv/handlers/model.js"
import quotaEnforcerAtNode from "./lib/agents/react/nodes/quotaEnforcerAtNode.js"
import quotaEnforcerAtStart from "./lib/agents/react/nodes/quotaEnforcerAtStart.js"
import shouldContinue from "./lib/agents/react/nodes/shouldContinue.js"
import { contentFilterRecoveryMiddleware } from "./lib/agents/markdown/middlewares/content-filter-recovery.js"
import { quotaEnforcerMiddleware } from "./lib/agents/markdown/middlewares/quota-enforcer.js"

/**
 * - CdsCheckpointSaver: LangGraph checkpointer backed by CDS entities (multi-turn, HITL)
 * - CdsTaskStore: A2A task persistence backed by CDS entities
 *   array-content messages from deepagents' built-in tools that SAP AI Core would otherwise reject
 */
export {
  CdsCheckpointSaver,
  CdsTaskStore,
  contentFilterRecoveryMiddleware,
  flattenMessages,
  quotaEnforcerMiddleware,
}

export const nodes = {
  quotaEnforcerAtStart,
  quotaEnforcerAtNode,
  shouldContinue,
}
