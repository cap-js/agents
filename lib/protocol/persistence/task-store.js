import cds from "@sap/cds"

const LOG = cds.log("agents")

const TASKS = "cap.agent.Tasks"

/**
 * CDS entity-backed store for A2A tasks.
 *
 * Implements the TaskStore interface from @a2a-js/sdk/server:
 *   save(task: Task): Promise<void>
 *   load(taskId: string): Promise<Task | undefined>
 */
export class CdsTaskStore {
  constructor() {
    this._cache = {}
  }

  async save(task) {
    if (!(task.status?.state in { 'submitted': 1, 'completed': 1 })) return
    if (cds.context["agent.new.task"]) {
      await INSERT.into(TASKS).entries({
        taskId: task.id,
        contextId: task.contextId,
        state: task.status?.state,
        data: JSON.stringify(task),
      })
      delete cds.context["agent.new.task"]
    } else {
      await UPDATE.entity(TASKS)
        .where({ taskId: task.id, createdBy: cds.context.user.id })
        .set({
          contextId: task.contextId,
          state: task.status?.state,
          data: JSON.stringify(task),
        })
    }

    this._cache[task.id] = task

    LOG._trace && LOG.debug("Task saved", { taskId: task.id, state: task.status?.state })
  }

  async load(taskId) {
    if (this._cache[taskId]) return this._cache[taskId]

    const row = await SELECT.one.from(TASKS).where({ taskId, createdBy: cds.context.user.id })
    if (!row) {
      LOG._trace && LOG.debug("Task not found", { taskId })
      return undefined
    }

    LOG._trace && LOG.debug("Task loaded", { taskId, state: row.state })
    return (this._cache[taskId] = JSON.parse(row.data))
  }
}
