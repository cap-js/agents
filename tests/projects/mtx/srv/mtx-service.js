import cds from "@sap/cds"
import { AIMessage } from "@langchain/core/messages"

export default class MtxTestService extends cds.ApplicationService {
  init() {
    this.on("buildModel", async (_req, next) => {
      const model = await next()
      const llm = model.name
      model._generate = async () => ({
        generations: [{ message: new AIMessage(llm) }],
      })
      model._streamResponseChunks = async function* _streamResponseChunks() {
        yield { message: new AIMessage(llm) }
      }
      return model
    })

    return super.init()
  }
}
