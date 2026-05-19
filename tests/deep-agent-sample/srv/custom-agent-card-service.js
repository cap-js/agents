const cds = require("@sap/cds")
const { path } = cds.utils

module.exports = class CustomAgentCardService extends cds.ApplicationService {
  async init() {
    // Passing the agent dir for automatic discovery of AGENT_CARD.md in the dir
    this.a2a = { agentDir: path.join(__dirname, "custom-agent-card") }
    await super.init()
  }
}
