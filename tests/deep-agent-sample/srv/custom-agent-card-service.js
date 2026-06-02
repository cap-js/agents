import cds from "@sap/cds"
const { path } = cds.utils

export default class CustomAgentCardService extends cds.ApplicationService {
  async init() {
    // Passing the agent dir for automatic discovery of AGENT_CARD.md in the dir
    this.a2a = { agentDir: path.join(import.meta.dirname, "custom-agent-card") }
    await super.init()
  }
}
