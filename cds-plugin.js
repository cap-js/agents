import cds from "@sap/cds"

const LOG = cds.log("agent")
import { patchLangChain } from "./lib/telemetry/tracing.js"
import cds_compile_to_a2a from "./lib/compile.js"
import registerDefaultAgentHandlers from "./srv/handlers/index.js"
import { slugified } from "./lib/utils/markdown.js"

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

cds.on('bootstrap', () => {
  const providers = {
    ['llm-mock']: {},
    ['llm-anthropic']: {
      opus: 'claude-opus-latest',
      sonnet: 'claude-sonnet-latest',
      haiku: 'claude-haiku-latest',
    },
    ['llm-aicore']: {
      opus: 'anthropic--claude-4.8-opus',
      sonnet: 'anthropic--claude-4.8-sonnet',
      haiku: 'anthropic--claude-4.6-haiku',
    }
  }

  for (const [name, s] of Object.entries(cds.env.requires)) {
    const kind = s?.kind ?? s
    if (typeof kind !== 'string') continue
    let [ provider, model ] = kind.split('/')
    if (name.startsWith('llm') && !providers[provider] && providers['llm-' + provider]) provider = 'llm-' + provider
    if (providers[provider] && model) {
      s.kind = provider
      s.model = providers[provider][model] ?? model
    }
  }
})

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

// Bootstrap sidecar mode when the agent-sidecar profile is active
if (cds.env.profiles?.includes("agent-sidecar")) {
  // Auto-mark @agent services as external so CDS does not serve them locally.
  // Auto-mark them as hcql services served externally, they are served from the main app.
  // This runs after model load but before cds.serve() filters definitions,
  // so users don't need to add these things manually.
  cds.on("loaded", (csn) => {
    const hcql = cds.requires.kinds["hcql"]
    const agentSidecar = cds.requires.agent || {}
    const hcqlBase = agentSidecar.url // For local development the base URL is given in the package.json
    const agentCredentials = agentSidecar.credentials || {}
    for (const [name, def] of Object.entries(csn.definitions || {})) {
      if (def.kind !== "service") continue
      if (!def["@agent"]) continue
      // Mark as external so CDS does not serve it locally — it will be served via HCQL from the main app.
      def["@cds.external"] = true
      // Java main apps use the CDS service name in the HCQL path (/hcql/CatalogService),
      // Node.js main apps use the slugified path (/hcql/catalog).
      const isJava = !cds.env.profiles?.includes("node")
      let n = isJava ? name : slugified(name)
      if (cds.requires[name]) continue // skip if user provided service-specific config for this service
      if (cds.requires[n]) continue // skip if user provided service-specific config for possibly the slugified version
      const newRequiresEntry = { ...hcql, kind: "hcql" }
      newRequiresEntry.credentials = {
        ...agentCredentials,
        ...(hcqlBase && { url: `${hcqlBase}/${n.split(".").pop()}` }),
        ...(agentCredentials.destination && { path: `/${n.split(".").pop()}` }),
      }
      cds.requires[n] = newRequiresEntry
    }
  })

  cds.on("served", async () => {
    const { bootstrapSidecar } = await import("./lib/sidecar.js")
    await bootstrapSidecar()
  })
}
