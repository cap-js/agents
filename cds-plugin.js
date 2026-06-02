import cds from "@sap/cds"

const LOG = cds.log("a2a")

// Detect optional peer plugins (@cap-js/telemetry, @cap-js/audit-logging)
const hasTelemetry = !!cds.env.requires?.telemetry
const hasAuditLog = !!cds.env.requires?.["audit-log"]
const hasMetrics = !!cds.env.requires?.telemetry?.["metrics"]
const hasTracing = !!cds.env.requires?.telemetry?.["tracing"]
if (!hasTelemetry) LOG.warn("@cap-js/telemetry not configured - metrics and tracing disabled")
if (!hasAuditLog) LOG.warn("@cap-js/audit-logging not configured - audit events disabled")
if (!hasMetrics) LOG.warn("@cap-js/telemetry has no metrics configured - metrics disabled")
if (!hasTracing) LOG.warn("@cap-js/telemetry has no tracing configured - tracing disabled")

// Enable doc comments in CSN for agent card generation
cds.env.cdsc = { ...cds.env.cdsc, docComment: true }

// Ensure A2A correlation fields are indexed by SAP Cloud Logging
cds.env.log ??= {}
const cls_fields = (cds.env.log.cls_custom_fields ??= [])
if (!cls_fields.includes("a2a.task.id")) cls_fields.push("a2a.task.id")
if (!cls_fields.includes("a2a.context.id")) cls_fields.push("a2a.context.id")

// LangChain monkey-patching for tracing (opt-out via cds.env.a2a.trace_langchain = false)
// Skipped when @cap-js/telemetry is not configured — patches would be wasted no-ops.
if (hasTelemetry && cds.env.a2a?.trace_langchain !== false) {
  const { patchLangChain } = await import("./lib/telemetry/tracing.js")
  patchLangChain()
}

// Register compile targets (cds compile -2 a2a)
const { registerCompileTargets } = await import("./lib/api.js")
registerCompileTargets()

// Register A2A as a CDS protocol adapter
// CDS protocols.serve uses require() which can't load ESM directly.
// We eagerly import and set impl as the loaded function.
const protocols = (cds.env.protocols ??= {})
if (!protocols.a2a) {
  const { default: a2aAdapter } = await import("./lib/index.js")
  protocols.a2a = {
    path: "/a2a",
    impl: a2aAdapter,
  }
}

// CORS support for browser-based A2A clients (development and hybrid profiles)
const isDev = cds.env.profiles?.includes("development") || cds.env.profiles?.includes("hybrid")
if (isDev) {
  cds.on("bootstrap", (app) => {
    app.use("/a2a", (req, res, next) => {
      res.set("Access-Control-Allow-Origin", req.headers.origin || "*")
      res.set("Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS")
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept")
      res.set("Access-Control-Allow-Credentials", "true")
      if (req.method === "OPTIONS") return res.status(204).end()
      next()
    })
  })
}

// Schedule active_users metric computation (only when telemetry plugin is present)
if (hasTelemetry) {
  cds.on("served", async () => {
    const { setupActiveUsersMetric } = await import("./lib/telemetry/active-users.js")
    setupActiveUsersMetric()
  })
}
