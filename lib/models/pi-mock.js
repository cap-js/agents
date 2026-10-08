import { createModels } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"

/** Pi mock model for testing — returns a fixed message string without hitting any real LLM. */
export default class PiMockModel {
  constructor(name, options = {}) {
    this.name = name
    this.options = options
    const message = options.message ?? "[Pi Mock] No real LLM invoked."
    const faux = fauxProvider({ provider: "pi-mock", models: [{ id: "mock" }] })
    faux.setResponses([fauxAssistantMessage(message)])
    const models = createModels()
    models.setProvider(faux.provider)
    this.model = models.getModel("pi-mock", "mock")
    this.streamFn = models.streamSimple.bind(models)
    this.getApiKey = () => ""
  }
}
