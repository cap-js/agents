import cds from "@sap/cds"
import { isAllowedDomain } from "../../utils/utils.js"

const LOG = cds.log("agent")

const CONFIGS = "cap.agent.PushNotificationConfigs"

/**
 * CDS entity-backed store for A2A push notification configs.
 *
 * Implements the PushNotificationStore interface from @a2a-js/sdk/server:
 *   save(taskId: string, config: PushNotificationConfig): Promise<void>
 *   load(taskId: string): Promise<PushNotificationConfig[]>
 *   delete(taskId: string, configId?: string): Promise<void>
 *
 * REVISIT: Currently only stores URL (no auth). When authenticated push callbacks needed:
 * - Persist authentication.schemes in DB (non-secret metadata)
 * - Store token/credentials in SAP Credential Store via @sap-cloud-sdk
 * - Reconstruct full PushNotificationConfig on load()
 * - See index.cds REVISIT comment for full plan
 */
export class CdsPushNotificationStore {
  async save(taskId, config) {
    const configId = config.id || taskId

    // Validate callback URL against configured domain allowlist
    const allowedDomains = cds.env.agents?.pushNotifications?.allowedDomains
    if (!isAllowedDomain(config.url, allowedDomains)) {
      const domains = Array.isArray(allowedDomains)
        ? allowedDomains.join(", ")
        : "(none configured)"
      throw new Error(cds.i18n.messages.at("PUSH_URL_NOT_ALLOWED", [config.url, domains]))
    }

    const existing = await SELECT.one
      .from(CONFIGS)
      .where({ taskId, configId, createdBy: cds.context.user.id })
    if (!existing) {
      await INSERT.into(CONFIGS).entries({ taskId, configId, url: config.url })
    } else {
      await UPDATE.entity(CONFIGS)
        .set({ url: config.url })
        .where({ taskId, configId, createdBy: cds.context.user.id })
    }
    LOG.debug("Push notification config saved", { taskId, configId })
  }

  async load(taskId) {
    const rows = await SELECT.from(CONFIGS).where({ taskId, createdBy: cds.context.user.id })
    return rows.map((r) => ({ id: r.configId, url: r.url }))
  }

  async delete(taskId, configId) {
    const where = { taskId, createdBy: cds.context.user.id }
    if (configId) where.configId = configId
    await DELETE.from(CONFIGS).where(where)
    LOG.debug("Push notification config deleted", { taskId, configId: configId || "all" })
  }
}
