import cds from "@sap/cds"

const LOG = cds.log("agents")
const registrations = new Map()
let timer
let active
let listener
let stopped = false
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const bindings = () => {
  try {
    return Object.values(JSON.parse(process.env.VCAP_SERVICES || "{}")).flat()
  } catch {
    return []
  }
}

const gateway = () => bindings().find((service) => service.label === "capa-agent-gateway")
const credentials = () =>
  cds.env.requires.auth?.credentials ||
  bindings().find((service) => service.label === "identity")?.credentials
const services = () =>
  Object.values(cds.services).filter(
    (service) => service.definition?.protocols?.agent || service.definition?.["@agent"],
  )

const applicationUrl = () => {
  const application = JSON.parse(process.env.VCAP_APPLICATION || "{}")
  const uri =
    application.application_uris?.find((candidate) => !candidate.includes(".cert.")) ||
    application.application_uris?.[0]
  return uri && `https://${uri}`
}

const registration = (service) => {
  const path = service.endpoints?.find((endpoint) => endpoint.kind === "agent")?.path
  const base = applicationUrl()
  const definition = service.definition
  return {
    agentKey: definition["@agent.key"] || service.name,
    name: definition["@title"] || definition["@Common.Label"] || service.name,
    description: definition["@description"],
    endpoint: base && path ? new URL(path, base).href.replace(/\/$/, "") : undefined,
    protocol: "A2A",
    visibility: "subaccount",
  }
}

const request = async (operation, data, timeout = 15000) => {
  const binding = gateway()
  const endpoint = binding?.credentials?.endpoints?.registry?.uri || binding?.credentials?.url
  const identity = credentials()
  if (!endpoint || !identity?.clientid) return
  const token = await cds.utils.token(identity, { form: { token_format: "jwt" } })
  const response = await cds.utils.fetch(
    new URL(operation, endpoint.replace(/\/?$/, "/")).href,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      data,
    },
    { timeout, credentials: identity },
  )
  return response.data?.value ?? response.data
}

const register = async () => {
  if (!gateway()) return
  await Promise.all(
    services().map(async (service) => {
      const agent = registration(service)
      if (registrations.has(agent.agentKey)) return
      const result = await request("register", { agent })
      if (result?.ID) registrations.set(agent.agentKey, { ID: result.ID, service })
      LOG.info(`registered ${agent.agentKey}`)
    }),
  )
}

const heartbeat = async () => {
  await Promise.all(
    [...registrations].map(async ([agentKey, registration]) => {
      try {
        await request("heartbeat", { ID: registration.ID })
      } catch (error) {
        if (error.status === 404) registrations.delete(agentKey)
        else throw error
      }
    }),
  )
}

const execute = async (invocation) => {
  const registration = registrations.get(invocation.agentKey)
  if (!registration) return
  try {
    const principal = JSON.parse(invocation.principal || "{}")
    const user = new cds.User({ id: principal.id || "system" })
    const context = new cds.EventContext({ user })
    const previous = invocation.contextId ? { contextId: invocation.contextId } : undefined
    const reply = await cds._with(context, () =>
      registration.service.chat(invocation.message, previous),
    )
    await request("completeInvocation", {
      ID: invocation.ID,
      reply: {
        text: reply.text,
        contextId: reply.contextId,
        taskId: reply.taskId,
        state: reply.status,
        steps: reply.steps,
      },
    })
  } catch (error) {
    LOG.warn("invocation failed", error)
    await request("completeInvocation", {
      ID: invocation.ID,
      error: String(error.message || error).slice(0, 1000),
    }).catch((completionError) => LOG.warn("invocation completion failed", completionError.message))
  }
}

const listen = async () => {
  try {
    if (!registrations.size) {
      await delay(1000)
    } else {
      const invocations = await request(
        "nextInvocation",
        { agentKeys: [...registrations.keys()], waitSeconds: 20 },
        30000,
      )
      if (invocations?.[0]) await execute(invocations[0])
    }
  } catch (error) {
    if (!stopped) LOG.warn("invocation polling failed", error.message)
    await delay(5000)
  } finally {
    if (!stopped) setImmediate(listen).unref()
  }
}

const cycle = async () => {
  if (active) return active
  active = (async () => {
    await heartbeat()
    await register()
  })().finally(() => (active = undefined))
  return active
}

const start = async () => {
  if (!gateway()) return
  try {
    await register()
  } catch (error) {
    LOG.warn("registration failed", error.message)
  }
  listener ??= listen()
  timer = setInterval(
    async () => {
      try {
        await cycle()
      } catch (error) {
        LOG.warn("heartbeat failed", error.message)
      }
    },
    Number(process.env.CAPA_HEARTBEAT_INTERVAL || 60000),
  )
  timer.unref()
}

cds.on("served", start)
cds.on("shutdown", () => {
  stopped = true
  clearInterval(timer)
})
