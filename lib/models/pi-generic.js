import { createModels } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"

const models = createModels()

/** `buildModel`-compatible Pi model, backed by a pi-ai built-in provider. */
export default class PiModel {
  constructor(name, options = {}) {
    const { credentials = {}, kind, model: modelName } = options

    if (!models.getProvider(kind)) {
      const provider = builtinProviders().find((p) => p.id === kind)
      if (!provider) throw new Error(`Pi does not know provider "${kind}"`)
      models.setProvider(provider)
    }

    // Use the catalog entry if known, else synthesize one from the provider's defaults.
    const model = { ...(models.getModel(kind, modelName) ?? { ...models.getModels(kind)[0], id: modelName }) }
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
