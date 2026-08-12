import cds from "@sap/cds"
import { isAllowedDomain } from "../lib/utils/utils.js"

const LOG = cds.log("agent")

// Hop limit for callback redirects. Real webhooks rarely need more than a
// single hop (protocol upgrade or CDN edge routing); 3 leaves headroom
// without opening a redirect loop as an amplifier.
const MAX_REDIRECTS = 3

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

  const allowedDomains = cds.env.agents?.pushNotifications?.allowedDomains
  const res = await fetchWithRedirects(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(10_000),
    },
    allowedDomains,
  )

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

/**
 * POST to `url` with manual redirect handling. Every hop (including the
 * initial URL) is re-validated against `allowedDomains` so a compromised or
 * open-redirect endpoint on an allow-listed domain cannot exfiltrate the
 * request body + Authorization header to an off-allowlist host.
 *
 * Policy:
 *  - Non-3xx responses are returned as-is.
 *  - 307 / 308 preserve method + body and follow if the new URL is allowlisted.
 *  - 301 / 302 / 303 would change POST semantics (spec allows GET downgrade)
 *    so they are refused - legitimate push webhooks never rely on that.
 *  - The redirect chain is capped at MAX_REDIRECTS. Absolute and relative
 *    Location values are both resolved against the previous URL.
 */
async function fetchWithRedirects(url, options, allowedDomains, maxRedirects = MAX_REDIRECTS) {
  let currentUrl = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedDomain(currentUrl, allowedDomains)) {
      throw new Error(
        `Push callback URL not on allowlist: ${currentUrl}` +
          (hop > 0 ? ` (reached via ${hop} redirect${hop === 1 ? "" : "s"})` : ""),
      )
    }

    // Never let fetch follow silently - we validate each hop explicitly.
    const res = await fetch(currentUrl, { ...options, redirect: "manual" })

    if (res.status < 300 || res.status >= 400) {
      return res
    }

    // 3xx: only 307 / 308 preserve method + body. 301 / 302 / 303 semantically
    // downgrade POST to GET - a push callback that relies on that is misconfigured.
    if (res.status !== 307 && res.status !== 308) {
      throw new Error(
        `Push callback redirect ${res.status} would change method or drop body; refusing`,
      )
    }

    if (hop === maxRedirects) {
      throw new Error(`Push callback exceeded ${maxRedirects} redirects`)
    }

    const location = res.headers.get("location")
    if (!location) {
      // 3xx without Location - nothing to follow, return as-is
      return res
    }

    // Resolve relative Locations against the previous URL.
    currentUrl = new URL(location, currentUrl).toString()
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
