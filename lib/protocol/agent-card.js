import cds from '@sap/cds'
import { createRequire } from "node:module"
import { getFilteredEntities, getFilteredActions } from "@cap-js/mcp/lib/utils/tools-shared.js"
import { getDescription, slugified } from "../utils/utils.js"
import { scanSkills, extractYamlFrontmatter } from "../utils/markdown.js"

const require = createRequire(import.meta.url)

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
    return require(cds.utils.path.join(cds.root, "package.json")).version || "1.0.0"
  } catch {
    return "1.0.0"
  }
}

function compileQueryEntitiesSkill(entities) {

  const descriptions = [], tags = []
  for (const [ name, entity ] of Object.entries(entities)) {
    let descriptionEntry = `  - ${name}`
    const description = getDescription(entity)?.trim()
    if (description) descriptionEntry = `${descriptionEntry}: ${description}`
    descriptions.push(descriptionEntry)
    tags.push(name.split('.').pop().toLowerCase())
  }

  return {
    id: "query",
    name: "Data Query",
    description: `Query data from the service. Available entities: \n ${descriptions.join('\n')}`,
    examples: [`Show me all ${Object.keys(entities)[0]}`],
    tags: ["query", "data", "read", ...tags],
  }
}

// TODO: Check if passing both params is necessary? Why not just action.name?
function compileCallActionSkill(actionName, action) {
  const actionDesc = getDescription(action)
    || `${action.kind === "function" ? "Get" : "Execute"} ${actionName}`

  const examples = []
  if (action.doc) for (const line of action.doc.split("\n")) {
    if (/^\s*example\s*:/i.test(line)) {
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

function _applyFromConfig(card) {
  const config = cds.env.agents.fileIO

  if (Array.isArray(config.defaultInputModes) && config.defaultInputModes.length)
    card.defaultInputModes = [...new Set(["text/plain", ...config.defaultInputModes])]
  if (Array.isArray(config.defaultOutputModes) && config.defaultOutputModes.length)
    card.defaultOutputModes = [...new Set(["text/plain", ...config.defaultOutputModes])]
}

function _applyFromServiceDefinition(card, srv) {
  // TODO: srv.definition ?? srv should not be happening here: IMO compile must only ever be called with the definition. 
  const description = getDescription(srv.definition ?? srv)
  if (description?.length) card.description = description

  const skills = []

  const entities = getFilteredEntities(srv)
  if (Object.keys(entities).length > 0) {
    const queryEntitiesSkill = compileQueryEntitiesSkill(entities)
    skills.push(queryEntitiesSkill)
  }

  const actions = getFilteredActions(srv)
  for (const [actionName, action] of Object.entries(actions)) {
    const actionSkill = compileCallActionSkill(actionName, action)
    skills.push(actionSkill)
  }

  card.skills = skills
}

function _applyFromAgentFile(card, agentDirectory) {
  const agentMeta = extractYamlFrontmatter(cds.utils.path.join(agentDirectory, 'AGENTS.md'))
  if (!agentMeta) return

  if (agentMeta.name) card.name = agentMeta.name
  if (agentMeta.description) card.description = agentMeta.description
  if (agentMeta.version) card.version = agentMeta.version

  const skills = scanSkills(cds.utils.path.join(agentDirectory, "skills"))

  card.skills.push(...skills)
}

// TODO: Is this `srv` the service instance or definition? Why would the instance ever be needed?
export function compileAgentCard(srv, resolved = undefined, serviceUrl = undefined) {
  serviceUrl ??= `/a2a/${slugified(srv.name)}`

  const card = {
    name: srv.name,
    description: `Agent for ${srv.name}`,
    url: serviceUrl,
    version: resolveVersion(),
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: serviceUrl, transport: "JSONRPC" }],
    capabilities: { streaming: true, pushNotifications: isPushNotificationsEnabled() },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"]
  }

  if (cds.env.agents?.fileIO?.enabled) {
    card.defaultInputModes = FILE_IO_MIME_TYPES
    card.defaultOutputModes = FILE_IO_MIME_TYPES

    _applyFromConfig(card)
  }

  _applyFromServiceDefinition(card, srv)

  if (resolved?.agentDir) _applyFromAgentFile(card, resolved.agentDir)

  return card
}
