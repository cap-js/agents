import cds from "@sap/cds"
import { validate, deltaChannelHistoryTests } from "@langchain/langgraph-checkpoint-validation"
import { CdsCheckpointSaver } from "../../lib/protocol/persistence/checkpoint-saver.js"

cds.test(import.meta.dirname + "/../projects/bookshop")

const setContext = () => {
  cds.context = { user: new cds.User({ id: "checkpointer-validation" }) }
}

const initializer = {
  checkpointerName: "CdsCheckpointSaver",
  createCheckpointer() {
    setContext()
    return new CdsCheckpointSaver()
  },
  async destroyCheckpointer() {
    // Each upstream suite must see only the state it created.
    await DELETE.from("cap.agent.CheckpointWrites")
    await DELETE.from("cap.agent.Checkpoints")
  },
}

// Validate both the production default and the full-persistence option.
describe.each([false, true])("persistAllCheckpointWrites=%s", (persistAllCheckpointWrites) => {
  let previousSetting
  beforeAll(() => {
    previousSetting = cds.env.agents.persistAllCheckpointWrites
    cds.env.agents.persistAllCheckpointWrites = persistAllCheckpointWrites
    setContext()
  })
  beforeEach(setContext)
  afterAll(() => {
    cds.env.agents.persistAllCheckpointWrites = previousSetting
    cds.context = undefined
  })

  validate(initializer)
  // Delta history is optional upstream and isn't registered by validate().
  deltaChannelHistoryTests(initializer)
})
