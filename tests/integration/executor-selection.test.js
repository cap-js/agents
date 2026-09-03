import { describe, expect, it } from "vitest"
import cds from "@sap/cds"

import { createExecutor } from "../../lib/executor.js"
import PiExecutor from "../../srv/pi-executor-srv.js"

describe("agent executor selection", () => {
  it("resolves the Pi executor from cds.requires.kinds", async () => {
    const previousExecutor = cds.requires["agent-executor"]
    const previousKind = cds.requires.kinds["agent-executor-pi-test"]
    cds.requires.kinds["agent-executor-pi-test"] = {
      impl: "@cap-js/agents/srv/pi-executor-srv",
    }
    cds.requires["agent-executor"] = { kind: "agent-executor-pi-test" }

    try {
      const executor = await createExecutor({ name: "TestService" })
      expect(typeof executor.execute).toBe("function")
      expect(PiExecutor._instance).toBeTruthy()
    } finally {
      cds.requires["agent-executor"] = previousExecutor
      if (previousKind === undefined) delete cds.requires.kinds["agent-executor-pi-test"]
      else cds.requires.kinds["agent-executor-pi-test"] = previousKind
    }
  })
})
