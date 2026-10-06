import cds from "@sap/cds"
import { getModel, streamSimple } from "@earendil-works/pi-ai"

const LOG = cds.log("agents")
const DEFAULT_MODEL = "gpt-4o"

/** `buildModel`-compatible Pi model for the OpenAI Chat Completions API. */
export default class PiOpenAIService {
  constructor(name, options = {}) {
    const { credentials = {}, ...rest } = options
    const config = { ...credentials, ...rest }
    const modelName = config.model || config.modelName || DEFAULT_MODEL

    const catalogModel = getModel("openai", modelName)
    if (!catalogModel) throw new Error(`Pi does not know model "openai/${modelName}"`)

    const model = { ...catalogModel }
    const baseUrl = config.openaiBaseUrl || config.baseUrl || config.baseURL || config.apiUrl || config.url
    if (baseUrl) model.baseUrl = baseUrl
    if (config.headers) model.headers = { ...model.headers, ...config.headers }

    LOG.debug("Using effective config for Pi OpenAI:", config)
    this.name = name
    this.options = config
    this.model = model
    this.api = model.api
    this.streamFn = streamSimple
    this.getApiKey = async () => config.apiKey
  }
}
