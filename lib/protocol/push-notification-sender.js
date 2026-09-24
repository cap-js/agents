import cds from "@sap/cds"

const LOG = cds.log("agents")

/**
 * CDS-based push notification sender with:
 * - IAS App-to-App client_credentials token exchange (when identity binding present)
 * - CAP outbox for reliable at-least-once delivery with retry
 * - Fallback to plain HTTP POST (dev mode, no identity binding)
 *
 * Implements PushNotificationSender interface from @a2a-js/sdk/server:
 *   send(task: Task): Promise<void>
 *
 * Token exchange uses @sap-cloud-sdk/connectivity getIasToken() which handles:
 * - mTLS or client_secret auth (based on identity binding credentials)
 * - Per-tenant tokens (appTid)
 * - Built-in LRU token cache
 */
export class CdsPushNotificationSender {
  constructor(pushNotificationStore) {
    this._store = pushNotificationStore
    this._outboxed = null
  }

  async send(task) {
    if (!task?.id) return

    const configs = await this._store.load(task.id)
    if (!configs?.length) return

    const outboxed = await this._getOutboxed()

    // Emit one event per push config — independent retry per target
    for (const config of configs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await outboxed.emit("pushNotification", {
          task,
          url: config.url,
        })
      } catch (err) {
        LOG.error("Failed to enqueue push notification", {
          taskId: task.id,
          url: config.url,
          error: err.message,
        })
      }
    }
  }

  async _getOutboxed() {
    if (this._outboxed) return this._outboxed
    const srv = await cds.connect.to("agent-push-notifications")
    this._outboxed = cds.outboxed(srv)
    return this._outboxed
  }
}
