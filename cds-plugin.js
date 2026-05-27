const cds = require("@sap/cds")

// Enable doc comments in CSN for agent card generation
cds.env.cdsc = { ...cds.env.cdsc, docComment: true }

// Ensure A2A correlation fields are indexed by SAP Cloud Logging
cds.env.log ??= {}
const cls_fields = (cds.env.log.cls_custom_fields ??= [])
if (!cls_fields.includes("a2a.task.id")) cls_fields.push("a2a.task.id")
if (!cls_fields.includes("a2a.context.id")) cls_fields.push("a2a.context.id")

// LangChain monkey-patching for tracing (opt-out via cds.env.a2a.trace_langchain = false)
if (cds.env.a2a?.trace_langchain !== false) {
  const { patchLangChain } = require("./lib/telemetry/tracing")
  patchLangChain()
}

// Register compile targets (cds compile -2 a2a)
require("./lib/api").registerCompileTargets()

// Register A2A as a CDS protocol adapter
const protocols = (cds.env.protocols ??= {})
if (!protocols.a2a) {
  protocols.a2a = {
    path: "/a2a",
    impl: require.resolve("./lib"),
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

// Schedule active_users metric computation
cds.on("served", () => {
  const { setupActiveUsersMetric } = require("./lib/telemetry/active-users")
  setupActiveUsersMetric()
})
