import cds from "@sap/cds"

const LOG = cds.log("agent")
import agentAdapter from "./lib/index.js"
import { patchLangChain } from "./lib/telemetry/tracing.js"
import cds_compile_to_a2a from "./lib/compile.js"
import registerDefaultAgentHandlers from "./srv/handlers/index.js"

cds.compile.to.a2a = cds_compile_to_a2a

// Detect optional peer plugins (@cap-js/telemetry, @cap-js/audit-logging)
const hasTelemetry = !!cds.env.requires?.telemetry
const hasAuditLog = !!cds.env.requires?.["audit-log"]
const hasMetrics = !!cds.env.requires?.telemetry?.["metrics"]
const hasTracing = !!cds.env.requires?.telemetry?.["tracing"]
if (!hasTelemetry && cds.env.profiles?.includes("production"))
  LOG.warn("@cap-js/telemetry not configured - metrics and tracing disabled")
if (!hasAuditLog && cds.env.profiles?.includes("production"))
  LOG.warn("@cap-js/audit-logging not configured - audit events disabled")
if (hasTelemetry && !hasMetrics && cds.env.profiles?.includes("production"))
  LOG.warn("@cap-js/telemetry has no metrics configured - metrics disabled")
if (hasTelemetry && !hasTracing && cds.env.profiles?.includes("production"))
  LOG.warn("@cap-js/telemetry has no tracing configured - tracing disabled")

// Enable doc comments in CSN for agent card generation
cds.env.cdsc = { ...cds.env.cdsc, docComment: true }

// Ensure A2A correlation fields are indexed by SAP Cloud Logging
cds.env.log ??= {}
const cls_fields = (cds.env.log.cls_custom_fields ??= [])
if (!cls_fields.includes("agent.task.id")) cls_fields.push("agent.task.id")
if (!cls_fields.includes("agent.context.id")) cls_fields.push("agent.context.id")

// Register A2A as a CDS protocol adapter
// Cant switch to package.json yet due to CAP not correctly reading ESM default export
const protocols = (cds.env.protocols ??= {})
if (!protocols.agent) {
  protocols.agent = {
    path: "/a2a",
    impl: agentAdapter,
  }
}

cds.on("serving", (srv) => {
  if (!(srv instanceof cds.ApplicationService)) return
  if (!srv.definition?.["@agent"]) return
  registerDefaultAgentHandlers(srv)
})

// Schedule active_users metric computation + MLflow exporter
cds.on("served", async () => {
  if (hasTelemetry) {
    const { setupActiveUsersMetric } = await import("./lib/telemetry/active-users.js")
    setupActiveUsersMetric()
    // Defer LangChain patching so the CDS model is fully loaded before patches land.
    // opt-out via cds.env.agents.trace_langchain = false
    if (cds.env.agents?.trace_langchain !== false) {
      await patchLangChain()
    }
  }

  if (cds.env.agents?.mlflow) {
    const { setupMlflowExporter } = await import("./lib/telemetry/mlflow.js")
    setupMlflowExporter()
  }
})
