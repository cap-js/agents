const cds = require("@sap/cds")

const LOG = cds.log("a2a")

const TASKS = "cap.a2a.Tasks"

/**
 * CDS entity-backed store for A2A tasks.
 *
 * Implements the TaskStore interface from @a2a-js/sdk/server:
 *   save(task: Task): Promise<void>
 *   load(taskId: string): Promise<Task | undefined>
 */
class CdsTaskStore {
  async save(task) {
    await UPSERT.into(TASKS).entries({
      taskId: task.id,
      contextId: task.contextId,
      state: task.status?.state,
      data: JSON.stringify(task),
    })

    LOG.debug("Task saved", { taskId: task.id, state: task.status?.state })
  }

  async load(taskId) {
    // REVISIT: Auth check to only query tasks for a given user
    const row = await SELECT.one.from(TASKS).where({ taskId })
    if (!row) {
      LOG.debug("Task not found", { taskId })
      return undefined
    }

    LOG.debug("Task loaded", { taskId, state: row.state })
    return JSON.parse(row.data)
  }
}

module.exports = { CdsTaskStore }
