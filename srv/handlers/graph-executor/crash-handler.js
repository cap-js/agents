import cds from "@sap/cds"
import { CdsTaskStore } from "../../../lib/protocol/persistence/task-store.js"

const LOG = cds.log("agents")

async function markActiveTasksFailed() {
  const tasksByTenant = {}

  for (const executor of registerShutdownHook.executors) {
    for (const taskId of executor._abortControllers.keys()) {
      const tenant = executor._taskTenants.get(taskId)
      ;(tasksByTenant[tenant] ??= []).push({ taskId, ...executor._taskContexts.get(taskId) })
    }
  }

  await Promise.all(
    Object.entries(tasksByTenant).map(async ([tenant, tasks]) => {
      if (tenant) return cds.spawn({ tenant, user: cds.User.privileged }, () => update(tasks))
      return update(tasks)
    }),
  )

  async function update(tasks) {
    const store = new CdsTaskStore()

    const proms = []
    for (const { taskId, contextId, serviceName } of tasks) {
      proms.push(
        store.save({
          id: taskId,
          contextId,
          status: { state: "failed" },
          agentService: serviceName,
        }),
      )
    }
    await Promise.all(proms)
  }
}

export function registerShutdownHook(executor) {
  registerShutdownHook.executors.add(executor)
  if (registerShutdownHook.executors.size > 1) return

  cds.on("shutdown", async () => {
    try {
      await markActiveTasksFailed()
    } catch (err) {
      LOG.error("Failed to mark active tasks as failed during shutdown", { error: err.message })
    }
  })
}

registerShutdownHook.executors = new Set()
