import { describe, expect, it } from "vitest"
import cds from "@sap/cds"

import { LangGraphExecutor } from "../../srv/langgraph-executor-srv.js"
import PiExecutor from "../../lib/protocol/pi-executor.js"

describe("agent executor selection", () => {
  it("resolves the Pi executor when harness is pi", async () => {
    const previousHarness = cds.env.agents?.harness
    cds.env.agents ??= {}
    cds.env.agents.harness = "pi"

    const srv = {
      name: "TestService",
      send: async (event) => {
        if (event === "buildTools") return []
        if (event === "buildSystemPrompt") return "Be helpful"
        if (event === "buildModel") return { model: {}, streamFn: async () => {}, getApiKey: () => "" }
        if (event === "buildGraph") {
          const agents = await import("../../lib/agents/index.js")
          return agents.default.for(srv)
        }
      },
    }

    try {
      const executorHandle = LangGraphExecutor.for(srv)
      expect(typeof executorHandle.execute).toBe("function")
    } finally {
      if (previousHarness === undefined) delete cds.env.agents.harness
      else cds.env.agents.harness = previousHarness
    }
  })
})
