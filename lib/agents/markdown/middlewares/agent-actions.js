import cds from "@sap/cds"
import { createMiddleware } from "langchain"
import * as metrics from "../../../telemetry/metrics.js"

/**
 * Middleware that increments the `agent_actions` metric on every LLM invocation
 * (agent node call) for deep agents.
 */
export async function agentActionsMiddleware() {
  return createMiddleware({
    name: "agentActionsMiddleware",
    afterModel: {
      hook: () => {
        metrics.agentActions.add(1, { "sap.tenantId": cds.context?.tenant || "anonymous" })
        return {}
      },
    },
  })
}
