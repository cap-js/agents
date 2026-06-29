import { CdsCheckpointSaver } from "./lib/protocol/persistence/checkpoint-saver.js"
import { CdsTaskStore } from "./lib/protocol/persistence/task-store.js"
import { flattenMessages } from "./srv/handlers/model.js"
import quotaEnforcerAtNode from "./lib/agents/react/nodes/quotaEnforcerAtNode.js"
import quotaEnforcerAtStart from "./lib/agents/react/nodes/quotaEnforcerAtStart.js"
import shouldContinue from "./lib/agents/react/nodes/shouldContinue.js"
import { contentFilterMiddleware } from "./lib/agents/markdown/middlewares/content-filter.js"
import { quotaEnforcerMiddleware } from "./lib/agents/markdown/middlewares/quota-enforcer.js"

/**
 * - CdsCheckpointSaver: LangGraph checkpointer backed by CDS entities (multi-turn, HITL)
 * - CdsTaskStore: A2A task persistence backed by CDS entities
 * - contentFilterMiddleware: Deep agent middleware for proactive input content filtering
 * - quotaEnforcerMiddleware: Deep agent middleware for per-task quota enforcement
 */
export {
  CdsCheckpointSaver,
  CdsTaskStore,
  contentFilterMiddleware,
  flattenMessages,
  quotaEnforcerMiddleware,
}

export const nodes = {
  quotaEnforcerAtStart,
  quotaEnforcerAtNode,
  shouldContinue,
}
