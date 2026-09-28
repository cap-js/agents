import cds from "@sap/cds"

const LOG = cds.log("agents")
const TASKS = "cap.agent.Tasks"

const executors = new Set()
let shutdownHookRegistered = false

async function markActiveTasksFailed() {
  const tasksByTenant = new Map()

  for (const executor of executors) {
    for (const taskId of executor._abortControllers.keys()) {
      const tenant = executor._taskTenants.get(taskId)
      const taskIds = tasksByTenant.get(tenant) || []
      taskIds.push(taskId)
      tasksByTenant.set(tenant, taskIds)
    }
  }

  await Promise.all(
    [...tasksByTenant].map(async ([tenant, taskIds]) => {
      const update = () =>
        UPDATE(TASKS)
          .where({
            taskId: { in: [...new Set(taskIds)] },
            state: { in: ["submitted", "working", "input-required"] },
          })
          .set({ state: "failed" })

      if (tenant) return cds.spawn({ tenant, user: cds.User.privileged }, update)
      return update()
    }),
  )
}

export function registerShutdownHook(executor) {
  executors.add(executor)
  if (shutdownHookRegistered) return

  shutdownHookRegistered = true
  cds.on("shutdown", async () => {
    try {
      await markActiveTasksFailed()
    } catch (err) {
      LOG.error("Failed to mark active tasks as failed during shutdown", { error: err.message })
    }
  })
}
