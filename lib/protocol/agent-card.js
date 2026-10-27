import cds from "@sap/cds"
import { createRequire } from "node:module"
const { path } = cds.utils
import { getFilteredEntities, getFilteredActions } from "@cap-js/mcp/lib/utils/tools-shared.js"
import { getDescription, slugified } from "../utils/utils.js"
import {
  scanSkills,
  parseAgentMetadata,
  parseAgentCardMd,
  parseAgentCardFile,
} from "../utils/markdown.js"

const require = createRequire(import.meta.url)

const LOG = cds.log("agents")

const FILE_IO_MIME_TYPES = [
  "text/csv",
  "application/json",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
]

// TODO: Why would this be called more than once?
function isPushNotificationsEnabled() {
  const cfg = cds.env.agents?.pushNotifications
  if (cfg === false) return false
  return true
}

// TODO: Why would this be called more than once?
function resolveVersion() {
  try {
    return require(path.join(cds.root, "package.json")).version || "1.0.0"
  } catch {
    return "1.0.0"
  }
}

function getAdditionalInputTypes() {
  const config = cds.env.agents?.fileIO
  if (!config?.enabled) return []
  if (config.defaultInputModes.length) return config.defaultInputModes
  return FILE_IO_MIME_TYPES
}

function getAdditionalOutputTypes() {
  const config = cds.env.agents?.fileIO
  if (!config?.enabled) return []
  if (config.defaultOutputModes.length) return config.defaultOutputModes
  return FILE_IO_MIME_TYPES
}

function compileQueryEntitiesSkill(entities) {

  const entityDescriptions = Object.entries(entities).map((name, entity) => {
    let entry = `  - ${name}`
    const description = getDescription(entity).trim()
    if (description) entry = `${entry}: ${description}`
    return entry
  }).join(" \n ")

  return {
    id: "query",
    name: "Data Query",
    description: `Query data from the service. Available entities: \n ${entityDescriptions}`,
    examples: [`Show me all ${Object.keys(entities)[0]}`],
    tags: ["query", "data", "read"],
  }
}

// TODO: Check if passing both params is necessary? Why not just action.name?
function compileCallActionSkill(actionName, action) {
  const actionDesc = getDescription(action)
    || `${action.kind === "function" ? "Get" : "Execute"} ${actionName}`

  const examples = []
  if (action.doc) for (const line of action.doc.split("\n")) {
    if (line.test(/^\s*example\s*:/i)) {
      const example = line.replace(/^\s*example\s*:\s*/i, "").trim()
      examples.push(example)
    }
  }
  if (!examples.length) examples.push(actionDesc)

  const tags = [actionName.toLowerCase(), action.kind]
  if (action.kind === "action") tags.push("hitl")

  return {
    id: actionName,
    name: actionName,
    description: actionDesc,
    examples,
    tags
  }
}

function generateAgentCardFromServiceDef(srv, serviceUrl) {
  // TODO: What is srv.definition? Why isn't this just srv?
  const description = getDescription(srv.definition) || `Agent for ${srv.name}`
  const entities = getFilteredEntities(srv)
  const actions = getFilteredActions(srv)

  const skills = []

  if (Object.keys(entities).length > 0) {
    const queryEntitiesSkill = compileQueryEntitiesSkill(entities)
    skills.push(queryEntitiesSkill)
  }

  for (const [actionName, action] of Object.entries(actions)) {
    const actionSkill = compileCallActionSkill(actionName, action)
    skills.push(actionSkill)
  }

  const card = {
    name: srv.name,
    description,
    url: serviceUrl,
    version: resolveVersion(),
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      { serviceUrl, transport: "JSONRPC" }
    ],
    capabilities: {
      pushNotifications: isPushNotificationsEnabled(),
      streaming: true,
    },
    defaultInputModes: [...new Set(["text/plain", ...getAdditionalInputTypes()])],
    defaultOutputModes: [...new Set(["text/plain", ...getAdditionalOutputTypes()])],
    skills,
  }

  LOG.debug("Generated agent card from CDS model", {
    service: srv.name,
    skills: card.skills.length,
  })

  return card
}

function compileAgentCardFromMeta(cardMeta, agentMeta, srv, servicePath, streaming = false) {
  // TODO: Why would `cardMeta.skills` not have the correct format already?
  const skills = (cardMeta.skills || []).map((skill) => ({
    id: skill.id || skill.name,
    name: skill.name || skill.id,
    description: skill.description || "",
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    examples: Array.isArray(skill.examples) ? skill.examples : [],
  }))

  const description = (
    cardMeta.description
    || agentMeta?.description
    || getDescription(srv.definition)
    || `Agent for ${srv.name}`
  ).trim()

  const card = {
    name: cardMeta.name || agentMeta?.name || srv.name,
    description,
    url: servicePath,
    version: resolveVersion(cardMeta.version || agentMeta?.version),
    // TODO: IMO the protocol should never be configurable?!
    protocolVersion: cardMeta.metadata?.protocolVersion || "0.3.0", 
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: servicePath, transport: "JSONRPC" }],
    capabilities: cardMeta.metadata?.capabilities || {
      streaming,
      pushNotifications: isPushNotificationsEnabled(),
    },
    defaultInputModes: cardMeta.defaultInputModes || ["text/plain"],
    defaultOutputModes: cardMeta.defaultOutputModes || ["text/plain"],
    skills,
  }

  return applyFileIOCapability(card)
}

function compileAgentCardFromFile(srv, servicePath, agentCardPath) {
  const cardMeta = parseAgentCardFile(agentCardPath)
  if (!cardMeta) cds.error({ status: 500, code: 'INVALID_AGENT_CARD' })

  // TODO: Get rid of this helper
  const card = compileAgentCardFromMeta(cardMeta, null, srv, servicePath, true)

  LOG.debug("Generated agent card from @agent.card annotation", {
    service: srv.name,
    path: agentCardPath,
    skills: card.skills.length,
  })

  return card
}

function compileAgentCardFromAgentsDirectory(srv, serviceUrl, agentDirectory) {
  const agentMeta = parseAgentMetadata(agentDirectory)
  const cardMeta = parseAgentCardMd(agentDirectory)

  if (cardMeta) {
    const card = compileAgentCardFromMeta(cardMeta, agentMeta, srv, serviceUrl, true)

    LOG.debug("Generated agent card from AGENT_CARD.md", {
      service: srv.name,
      skills: card.skills.length,
    })

    return card
  }

  const description = (
    agentMeta?.description ||
    getDescription(srv.definition) ||
    `Agent for ${srv.name}`
  ).trim()

  const card = {
    name: agentMeta?.name || srv.name,
    description,
    url: serviceUrl,
    version: agentMeta?.version ?? resolveVersion(),
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: serviceUrl, transport: "JSONRPC" }],
    capabilities: { streaming: true, pushNotifications: isPushNotificationsEnabled() },
    defaultInputModes: [...new Set(["text/plain", ...getAdditionalInputTypes()])],
    defaultOutputModes: [...new Set(["text/plain", ...getAdditionalOutputTypes()])],
    skills: scanSkills(path.join(agentDirectory, "skills")),
  }

  LOG.debug("Generated agent card from skills/", {
    service: srv.name,
    skills: card.skills.length,
  })

  return card
}

// TODO: Is this `srv` the service instance or definition? Why would the instance ever be needed?
export function compileAgentCard(srv, resolved = undefined, options = {}) {
  const serviceUrl = options.path || `/a2a/${slugified(srv.name)}`

  // const card = {
  //   protocolVersion: "0.3.0",
  //   preferredTransport: "JSONRPC",
  //   additionalInterfaces: [{ url: serviceUrl, transport: "JSONRPC" }],
  //   capabilities: { streaming: true, pushNotifications: isPushNotificationsEnabled() },
  // }

  if (resolved?.agentCardPath) // REVISIT: Remove this option?
    return compileAgentCardFromFile(srv, serviceUrl, resolved.agentCardPath, options)

  if (resolved?.agentDir)
    return compileAgentCardFromAgentsDirectory(srv, serviceUrl, resolved.agentDir)

  return generateAgentCardFromServiceDef(srv, serviceUrl)
}
