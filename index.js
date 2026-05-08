/**
 * - CdsCheckpointSaver: LangGraph checkpointer backed by CDS entities (multi-turn, HITL)
 * - CdsTaskStore: A2A task persistence backed by CDS entities
 * - createDeepAgentModel: LLM model factory for use with deepagents — handles array-content
 *   messages from deepagents' built-in tools that SAP AI Core would otherwise reject
 * - generateTools: Creates LangChain tools from a CDS service model (query, describe, per-action)
 */
module.exports = {
  CdsCheckpointSaver: require("./lib/persistence/checkpoint-saver").CdsCheckpointSaver,
  CdsTaskStore: require("./lib/persistence/task-store").CdsTaskStore,
  createDeepAgentModel: require("./lib/model").createDeepAgentModel,
  generateTools: require("./lib/tools").generateTools,
}
