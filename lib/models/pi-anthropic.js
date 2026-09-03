import cds from "@sap/cds"
import { createModels } from "@earendil-works/pi-ai"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"

import { anthropicConfig } from "./anthropic.js"

const LOG = cds.log("agents")
const DEFAULT_MODEL = "claude-sonnet-4-6"

/** `buildModel`-compatible Pi model for the Anthropic Messages API. */
export default class PiAnthropicService {
  constructor(name, options = {}) {
    const credentials = options.credentials || {}
    const config = anthropicConfig({ ...credentials, ...options })
    const modelName = config.model || config.modelName || DEFAULT_MODEL
    const models = createModels()
    models.setProvider(anthropicProvider())

    const catalogModel = models.getModel("anthropic", modelName)
    if (!catalogModel) throw new Error(`Pi does not know model "anthropic/${modelName}"`)

    const model = { ...catalogModel }
    const baseUrl = config.anthropicApiUrl || config.baseUrl || config.apiUrl || config.url
    if (baseUrl) model.baseUrl = baseUrl
    if (config.headers) model.headers = { ...model.headers, ...config.headers }

    LOG.debug("Using effective config for Pi Anthropic:", config)
    this.name = name
    this.options = config
    this.model = model
    this.streamFn = models.streamSimple.bind(models)
    this.getApiKey = async () => config.apiKey || config.anthropicApiKey
  }
}
