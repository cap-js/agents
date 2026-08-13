import cds from "@sap/cds"

const LOG = cds.log("agents")

/**
 * CDS service that handles push notification delivery.
 * Registered as `agent-push-notifications` and wrapped in CAP outbox
 * by CdsPushNotificationSender for at-least-once delivery with retry.
 */
export default class AgentPushNotificationService extends cds.Service {
  async init() {
    this.on("pushNotification", async (msg) => {
      const { task, url } = msg.data
      await pushNotification(url, task)
    })
    return super.init()
  }
}

async function pushNotification(url, task) {
  const headers = { "Content-Type": "application/json" }

  const iasResource = cds.env.agents?.pushNotifications?.ias?.resource
  if (iasResource) {
    const bearerToken = await fetchIasToken(iasResource)
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(task),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    // Throw so outbox retries on transient failures (5xx, network)
    const body = await res.text().catch(() => "")
    const msg = `Push notification failed: HTTP ${res.status} ${res.statusText}`
    if (res.status >= 500 || res.status === 429) {
      throw cds.error({ message: msg, response: body }) // retryable
    }
    // 4xx = permanent failure, log and don't retry
    LOG.error(msg, { taskId: task.id, url, response: body })
  } else {
    LOG.debug("Push notification delivered", { taskId: task.id, url, status: res.status })
  }
}

async function fetchIasToken(resource) {
  let getIasToken
  try {
    ;({ getIasToken } = await import("@sap-cloud-sdk/connectivity"))
  } catch {
    LOG.debug("@sap-cloud-sdk/connectivity not available, skipping IAS token")
    return null
  }

  const tenant = cds.context?.tenant
  const options = {
    resource: { name: resource },
    ...(tenant && { appTid: tenant }),
  }

  try {
    const result = await getIasToken(options)
    return result?.access_token || result?.token || result
  } catch (err) {
    // No identity binding → expected in dev/test
    if (
      err.message?.includes("identity") ||
      err.message?.includes("service binding") ||
      err.message?.includes("not found")
    ) {
      LOG.debug("No identity service binding, push without auth", { resource })
      return null
    }
    throw err
  }
}
