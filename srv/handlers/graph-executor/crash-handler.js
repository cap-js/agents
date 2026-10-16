import cds from "@sap/cds"

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
    const { Messages } = cds.entities("cap.agent")
    await INSERT.into(Messages).entries(
      tasks.map(({ contextId, serviceName }) => ({
        ID: cds.utils.uuid(),
        session: contextId,
        sequence: 0,
        role: "ai",
        type: "failed",
        content: "",
        agentService: serviceName,
      })),
    )
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
