import { CdsCheckpointSaver } from "./lib/protocol/persistence/checkpoint-saver.js"
import { CdsTaskStore } from "./lib/protocol/persistence/task-store.js"
import { flattenMessages } from "./srv/handlers/model.js"

/**
 * - CdsCheckpointSaver: LangGraph checkpointer backed by CDS entities (multi-turn, HITL)
 * - CdsTaskStore: A2A task persistence backed by CDS entities
 */
export { CdsCheckpointSaver, CdsTaskStore, flattenMessages }
