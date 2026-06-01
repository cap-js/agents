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
    if (cds.context["a2a.new.task"]) {
      await INSERT.into(TASKS).entries({
        taskId: task.id,
        contextId: task.contextId,
        state: task.status?.state,
        data: JSON.stringify(task),
      })
      delete cds.context["a2a.new.task"]
    } else {
      await UPDATE.entity(TASKS)
        .where({ taskId: task.id })
        .set({
          contextId: task.contextId,
          state: task.status?.state,
          data: JSON.stringify(task),
        })
    }

    LOG.debug("Task saved", { taskId: task.id, state: task.status?.state })
  }

  async load(taskId) {
    const row = await SELECT.one.from(TASKS).where({ taskId, createdBy: cds.context.user.id })
    if (!row) {
      LOG.debug("Task not found", { taskId })
      return undefined
    }

    LOG.debug("Task loaded", { taskId, state: row.state })
    return JSON.parse(row.data)
  }
}

module.exports = { CdsTaskStore }
