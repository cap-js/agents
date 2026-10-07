import { createModels } from "@earendil-works/pi-ai"

const models = createModels()

/** `buildModel`-compatible Pi model for the OpenAI Chat Completions API. */
export default class PiModel {
  constructor(name, options = {}) {
    const { credentials = {}, kind, model: modelName } = options

    let catalogModel = models.getModel(kind, modelName)
    if (!catalogModel) {
      // model not in catalog — synthesize from provider defaults
      const [template] = models.getModels("openai")
      if (!template) throw new Error(`Pi does not know provider "${kind}"`)
      catalogModel = { ...template, id: modelName }
    }

    const model = { ...catalogModel }
    // REVISIT: just normalize everything to credentials.url
    const baseUrl = credentials.anthropicApiUrl || credentials.openaiBaseUrl || credentials.baseUrl || credentials.baseURL || credentials.apiUrl || credentials.url
    if (baseUrl) model.baseUrl = baseUrl

    this.name = name
    this.options = options
    this.model = model
    this.api = model.api
    this.streamFn = models.streamSimple.bind(models)
    this.getApiKey = () => credentials.apiKey
  }
}
