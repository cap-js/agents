const cds = require("@sap/cds")
const { path } = cds.utils

module.exports = class CustomAgentCardService extends cds.ApplicationService {
  async init() {
    this.a2a = { agentCardPath: path.join(__dirname, "custom-agent-card.md") }
    await super.init()
  }
}
