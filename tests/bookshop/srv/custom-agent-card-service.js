import cds from "@sap/cds"
const { path } = cds.utils

export default class CustomAgentCardService extends cds.ApplicationService {
  async init() {
    this.a2a = { agentCardPath: path.join(import.meta.dirname, "custom-agent-card.md") }
    await super.init()
  }
}
