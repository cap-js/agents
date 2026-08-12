const orchestrationClients = vi.hoisted(() => [])

vi.mock("@sap-ai-sdk/langchain", () => {
  class OrchestrationClient {
    constructor(orchestrationConfig, clientConfig, deploymentConfig, destination) {
      this.orchestrationConfig = orchestrationConfig
      this.clientConfig = clientConfig
      this.deploymentConfig = deploymentConfig
      this.destination = destination
      orchestrationClients.push(this)
    }

    async invoke() {}
  }

  return { OrchestrationClient }
})

import { contentFilterMiddleware } from "../../lib/agents/middleware/content-filter.js"

const inputContentFilter = {
  azure_content_safety: {
    hate: "ALLOW_SAFE_LOW",
    prompt_shield: true,
  },
}

describe("@cap-js/agents - Content Filter Destination Connectivity", () => {
  beforeEach(() => {
    orchestrationClients.length = 0
  })

  async function buildMiddleware(model = {}) {
    await contentFilterMiddleware({
      ...model,
      options: { contentFilter: { input: inputContentFilter } },
    })
    expect(orchestrationClients).toHaveLength(1)
  }

  it("forwards destination and resource group to the input content-filter probe", async () => {
    const model = {
      deploymentConfig: { resourceGroup: "agents" },
      destination: { destinationName: "prod-aicore" },
    }

    await buildMiddleware(model)

    expect(orchestrationClients[0].deploymentConfig).toEqual(model.deploymentConfig)
    expect(orchestrationClients[0].destination).toEqual(model.destination)
  })

  it("forwards resource-group-only deployment config to the input content-filter probe", async () => {
    const model = { deploymentConfig: { resourceGroup: "agents" } }

    await buildMiddleware(model)

    expect(orchestrationClients[0].deploymentConfig).toEqual(model.deploymentConfig)
    expect(orchestrationClients[0].destination).toBeUndefined()
  })

  it("leaves destination options undefined when the model has none", async () => {
    await buildMiddleware()

    expect(orchestrationClients[0].deploymentConfig).toBeUndefined()
    expect(orchestrationClients[0].destination).toBeUndefined()
  })
})
