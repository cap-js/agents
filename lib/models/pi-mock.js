import { createModels } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"

const DEFAULT_MESSAGE =
  "[Mock LLM] This is a mocked response from @cap-js/agents development mode. No real LLM was invoked."

/** `buildModel`-compatible deterministic Pi model for local development. */
export default class PiMockService {
  constructor(name, options = {}) {
    const modelName = options.model || "mock"
    const faux = fauxProvider({ provider: "mock", models: [{ id: modelName }] })
    const response = () => {
      faux.appendResponses([response])
      return fauxAssistantMessage(options.message || DEFAULT_MESSAGE)
    }
    faux.setResponses([response])

    const models = createModels()
    models.setProvider(faux.provider)

    this.name = name
    this.options = options
    this.model = models.getModel("mock", modelName)
    this.streamFn = models.streamSimple.bind(models)
  }
}
