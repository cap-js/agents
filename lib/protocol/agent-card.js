import cds from "@sap/cds"
import { createRequire } from "node:module"
import { getFilteredEntities, getFilteredActions } from "@cap-js/mcp/lib/utils/tools-shared.js"
import { getDescription, slugified } from "../utils/utils.js"
import { scanSkillManifests, extractYamlFrontmatter } from "../utils/markdown.js"

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

function resolveVersion() {
  if (resolveVersion._cache) return resolveVersion._cache
  try {
    return (resolveVersion._cache =
      require(cds.utils.path.join(cds.root, "package.json")).version || "1.0.0")
  } catch {
    return (resolveVersion._cache = "1.0.0")
  }
}

function compileQueryEntitiesSkill(entities) {
  const descriptions = [],
    tags = []
  for (const [name, entity] of Object.entries(entities)) {
    let descriptionEntry = `  - ${name}`
    const description = getDescription(entity)?.trim()
    if (description) descriptionEntry = `${descriptionEntry}: ${description}`
    descriptions.push(descriptionEntry)
    tags.push(name.split(".").pop().toLowerCase())
  }

  return {
    id: "query",
    name: "Data Query",
    description: `Query data from the service. Available entities: \n ${descriptions.join("\n")}`,
    examples: [`Show me all ${Object.keys(entities)[0]}`],
    tags: ["query", "data", "read", ...tags],
  }
}

function compileCallActionSkill(actionName, action) {
  const actionDesc =
    getDescription(action) || `${action.kind === "function" ? "Get" : "Execute"} ${actionName}`

  const examples = []
  if (action.doc)
    for (const line of action.doc.split("\n")) {
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
    tags,
  }
}

function _applyFromConfig(card) {
  const config = cds.env.agents.fileIO

  if (Array.isArray(config.defaultInputModes) && config.defaultInputModes.length)
    card.defaultInputModes = [...new Set(["text/plain", ...config.defaultInputModes])]
  if (Array.isArray(config.defaultOutputModes) && config.defaultOutputModes.length)
    card.defaultOutputModes = [...new Set(["text/plain", ...config.defaultOutputModes])]
}

function _applyFromServiceDefinition(card, srvDef) {
  const description = getDescription(srvDef)
  if (description?.length) card.description = description

  const skills = []

  const entities = getFilteredEntities(srvDef)
  if (Object.keys(entities).length > 0) {
    const queryEntitiesSkill = compileQueryEntitiesSkill(entities)
    skills.push(queryEntitiesSkill)
  }

  const actions = getFilteredActions(srvDef)
  for (const [actionName, action] of Object.entries(actions)) {
    const actionSkill = compileCallActionSkill(actionName, action)
    skills.push(actionSkill)
  }

  card.skills = skills
  LOG.debug("applied service definition", {
    service: srvDef.name,
    entities: Object.keys(entities).length,
    actions: Object.keys(actions).length,
  })
}

function compileSkill(meta) {
  return {
    id: meta.name,
    name: meta.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: (meta.description || "").trim(),
    tags: meta.metadata?.tags || [],
    examples: meta.metadata?.examples || [],
  }
}

function _applyFromAgentFile(card, agentDirectory) {
  const skills = scanSkillManifests(cds.utils.path.join(agentDirectory, "skills"))
    .map(compileSkill)
    .sort((a, b) => a.id.localeCompare(b.id))

  card.skills.push(...skills)

  const agentMeta = extractYamlFrontmatter(cds.utils.path.join(agentDirectory, "AGENTS.md"))
  if (!agentMeta) return

  if (agentMeta.name) card.name = agentMeta.name
  if (agentMeta.description) card.description = agentMeta.description
  if (agentMeta.version) card.version = agentMeta.version

  LOG.debug("applied agent file", { dir: agentDirectory, skills: skills.length })
}

/**
 * Compiles an A2A agent card according to:
 * https://a2a-protocol.org/v0.3.0/specification/#5-agent-discovery-the-agent-card
 *
 * @param {cds.linked.classes.service} srvDef cds.linked service definition
 * @param {string | undefined} agentDir string path to directory holding AGENTS.md etc.
 * @param {string} serviceUrl absolute URL for agent access at runtime
 * @returns agent-card object
 */
export function compileAgentCard(srvDef, agentDir = undefined, serviceUrl = undefined) {
  serviceUrl ??= `/a2a/${slugified(srvDef.name)}`

  const card = {
    name: srvDef.name,
    description: `Agent for ${srvDef.name}`,
    url: serviceUrl,
    version: resolveVersion(),
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: serviceUrl, transport: "JSONRPC" }],
    capabilities: {
      streaming: true,
      pushNotifications: cds.env.agents?.pushNotifications !== false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  }

  if (cds.env.agents?.fileIO?.enabled) {
    card.defaultInputModes = FILE_IO_MIME_TYPES
    card.defaultOutputModes = FILE_IO_MIME_TYPES

    _applyFromConfig(card)
  }

  _applyFromServiceDefinition(card, srvDef)

  if (agentDir) _applyFromAgentFile(card, agentDir)

  LOG.debug("compiled agent-card", { service: srvDef.name, skills: card.skills?.length ?? 0 })
  return card
}
