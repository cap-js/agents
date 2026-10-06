import cds from "@sap/cds"
import { getModel, streamSimple } from "@earendil-works/pi-ai"

const LOG = cds.log("agents")
const DEFAULT_MODEL = "claude-sonnet-4-6"

/** `buildModel`-compatible Pi model for the Anthropic Messages API. */
export default class PiAnthropicService {
  constructor(name, options = {}) {
    const { credentials = {}, ...rest } = options
    const config = { ...credentials, ...rest }
    const modelName = config.model || config.modelName || DEFAULT_MODEL

    const catalogModel = getModel("anthropic", modelName)
    if (!catalogModel) throw new Error(`Pi does not know model "anthropic/${modelName}"`)

    const model = { ...catalogModel }
    const baseUrl = config.anthropicApiUrl || config.baseUrl || config.baseURL || config.apiUrl || config.url
    if (baseUrl) model.baseUrl = baseUrl
    if (config.headers) model.headers = { ...model.headers, ...config.headers }

    LOG.debug("Using effective config for Pi Anthropic:", config)
    this.name = name
    this.options = config
    this.model = model
    this.streamFn = streamSimple
    this.getApiKey = async () => config.apiKey || config.anthropicApiKey
  }
}
