import cds from "@sap/cds"
import { appendMessage } from "../../../lib/protocol/persistence/message-store.js"

const LOG = cds.log("agents")

// REVISIT: Check if in the future tasks can be picked up again after restart
async function markActiveTasksFailed() {
  const tasksByTenant = new Map()

  for (const executor of registerShutdownHook.executors) {
    for (const taskId of executor._abortControllers.keys()) {
      const tenant = executor._taskTenants.get(taskId)
      const tasks = tasksByTenant.get(tenant) || []
      tasks.push({ taskId, ...executor._taskContexts.get(taskId) })
      tasksByTenant.set(tenant, tasks)
    }
  }

  await Promise.all(
    [...tasksByTenant].map(async ([tenant, tasks]) => {
      const update = () =>
        Promise.all(
          tasks.map(({ taskId, contextId, serviceName }) =>
            appendMessage({
              ID: `crash-${taskId}`,
              session: contextId,
              prev_ID: taskId,
              role: "assistant",
              type: "failed",
              content: [],
              query: { status: { state: "failed" } },
              agentService: serviceName,
            }),
          ),
        )

      if (tenant) return cds.spawn({ tenant, user: cds.User.privileged }, update)
      return update()
    }),
  )
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
