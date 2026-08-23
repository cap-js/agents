import cds from "@sap/cds"

// const defaults = { path: '/a2a', impl: '@cap-js/agents' }
// const protocols = cds.env.protocols ??= {}
// protocols.agent ??= {}
// protocols.agent = { ...defaults, ...protocols.graphql}

// ...
import cds_compile_to_a2a from "./lib/compile.js"
cds.compile.to.a2a = cds_compile_to_a2a

// TODO: move to package.json
// Enable doc comments in CSN for agent card generation
cds.env.cdsc = { ...cds.env.cdsc, docComment: true }

// TODO: there must be a better way to achieve this
// Ensure A2A correlation fields are indexed by SAP Cloud Logging
cds.env.log ??= {}
const cls_fields = (cds.env.log.cls_custom_fields ??= [])
if (!cls_fields.includes("agent.task.id")) cls_fields.push("agent.task.id")
if (!cls_fields.includes("agent.context.id")) cls_fields.push("agent.context.id")
