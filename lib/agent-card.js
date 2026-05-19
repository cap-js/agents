const cds = require("@sap/cds")
const { path } = cds.utils
const { getDescription, getFilteredEntities, getFilteredActions } = require("./utils")
const {
  scanSkills,
  parseAgentMetadata,
  parseAgentCardMd,
  parseAgentCardFile,
} = require("./markdown")

const LOG = cds.log("a2a")

// Replicate CAP's internal slugified function for service path generation
const slugified = (name) =>
  /[^.]+$/
    .exec(name)[0]
    .replace(/Service$/, "")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, (_m, c, C) => c + "-" + C)
    .toLowerCase()

/**
 * Lines starting with "Example:" (case-insensitive) are parsed as skill examples.
 */
function getDocExamples(def) {
  if (!def.doc) return []
  return def.doc
    .split("\n")
    .filter((line) => /^\s*example\s*:/i.test(line))
    .map((line) => line.replace(/^\s*example\s*:\s*/i, "").trim())
    .filter(Boolean)
}

/**
 * Generate skills from entities and actions (agentify mode).
 */
function generateSkills(entities, actions) {
  const skills = []
  const entityNames = Object.keys(entities)

  if (entityNames.length > 0) {
    const entityDescriptions = entityNames
      .map((name) => {
        const desc = getDescription(entities[name])
        return desc ? `${name}: ${desc}` : name
      })
      .join(" \n ")

    skills.push({
      id: "query",
      name: "Data Query",
      description: `Query data from the service. Available entities: \n ${entityDescriptions}`,
      examples: [`Show me all ${entityNames[0]}`],
      tags: ["query", "data", "read", ...entityNames.slice(0, 3).map((n) => n.toLowerCase())],
    })
  }

  for (const [name, action] of Object.entries(actions)) {
    const description =
      getDescription(action) || `${action.kind === "function" ? "Get" : "Execute"} ${name}`

    const docExamples = getDocExamples(action)
    const examples = docExamples.length > 0 ? docExamples : [description]

    const tags = [name.toLowerCase(), action.kind]
    if (action.kind === "action") tags.push("hitl")

    skills.push({ id: name, name, description, examples, tags })
  }

  return skills
}

/**
 * Build agent card from explicit params (used by compile.js for compile-time generation).
 */
function buildAgentCard({ name, description, entities, actions, url }) {
  const skills = generateSkills(entities, actions)

  let version = "0.0.1"
  try {
    version = require(path.join(cds.root, "package.json")).version || version
  } catch {
    /* fallback */
  }

  return {
    name,
    description,
    url,
    version,
    protocolVersion: "0.3.0",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "0.3.0" }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  }
}

/**
 * Build agent card from CDS model (agentify mode, runtime).
 */
function buildAgentCardFromModel(srv, servicePath) {
  return buildAgentCard({
    name: srv.name,
    description: getDescription(srv.definition) || `Agent for ${srv.name}`,
    entities: getFilteredEntities(srv),
    actions: getFilteredActions(srv),
    url: servicePath,
  })
}

/**
 * Build agent card from AGENT_CARD.md (explicit card file).
 */
function buildAgentCardFromCardFile(cardMeta, agentMeta, srv, servicePath) {
  let version = cardMeta.version || agentMeta?.version
  try {
    version = version || require(path.join(cds.root, "package.json")).version
  } catch {
    /* fallback */
  }
  version = version || "1.0.0"

  const skills = (cardMeta.skills || []).map((s) => ({
    id: s.id || s.name,
    name: s.name || s.id,
    description: s.description || "",
    tags: Array.isArray(s.tags) ? s.tags : [],
    examples: Array.isArray(s.examples) ? s.examples : [],
  }))

  return {
    name: cardMeta.name || agentMeta?.name || srv.name,
    description: (
      cardMeta.description ||
      agentMeta?.description ||
      getDescription(srv.definition) ||
      `Agent for ${srv.name}`
    ).trim(),
    url: servicePath,
    version,
    protocolVersion: cardMeta.metadata?.protocolVersion || "0.3.0",
    supportedInterfaces: [
      { url: servicePath, protocolBinding: "JSONRPC", protocolVersion: "0.3.0" },
    ],
    capabilities: cardMeta.metadata?.capabilities || { streaming: false, pushNotifications: false },
    defaultInputModes: cardMeta.defaultInputModes || ["text/plain"],
    defaultOutputModes: cardMeta.defaultOutputModes || ["text/plain"],
    skills,
  }
}

/**
 * Build agent card from skills/ directory scan.
 */
function buildAgentCardFromSkills(agentDir, agentMeta, srv, servicePath) {
  const skills = scanSkills(path.join(agentDir, "skills"))

  let version = agentMeta?.version
  try {
    version = version || require(path.join(cds.root, "package.json")).version
  } catch {
    /* fallback */
  }
  version = version || "1.0.0"

  return {
    name: agentMeta?.name || srv.name,
    description: (
      agentMeta?.description ||
      getDescription(srv.definition) ||
      `Agent for ${srv.name}`
    ).trim(),
    url: servicePath,
    version,
    protocolVersion: "0.3.0",
    supportedInterfaces: [
      { url: servicePath, protocolBinding: "JSONRPC", protocolVersion: "0.3.0" },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  }
}

/**
 * Generate the A2A agent card for a service.
 *
 * Resolution chain:
 *   1. srv.a2a.agentCardPath → explicit path to agent card markdown file
 *   2. srv.a2a.agentDir/AGENT_CARD.md → convention within agent directory
 *   3. srv.a2a.agentDir/skills/ scan → auto-generated from SKILL.md frontmatter
 *   4. CDS model → entities + actions (agentify fallback)
 */
function generateAgentCard(srv, options = {}) {
  const servicePath = options.path || `/a2a/${slugified(srv.name)}`
  const agentCardPath = srv.a2a?.agentCardPath
  const agentDir = srv.a2a?.agentDir

  // Priority 1: Explicit agentCardPath
  if (agentCardPath) {
    const cardMeta = parseAgentCardFile(agentCardPath)
    if (cardMeta) {
      const card = buildAgentCardFromCardFile(cardMeta, null, srv, servicePath)
      LOG.debug("Generated agent card from agentCardPath", {
        service: srv.name,
        path: agentCardPath,
        skills: card.skills.length,
      })
      return card
    }
    LOG.warn("Agent card file not found or invalid YAML, falling back", {
      service: srv.name,
      path: agentCardPath,
    })
  }

  if (agentDir) {
    const agentMeta = parseAgentMetadata(agentDir)

    // Priority 2: AGENT_CARD.md in agentDir (convention)
    const cardMeta = parseAgentCardMd(agentDir)
    if (cardMeta) {
      const card = buildAgentCardFromCardFile(cardMeta, agentMeta, srv, servicePath)
      LOG.debug("Generated agent card from AGENT_CARD.md", {
        service: srv.name,
        skills: card.skills.length,
      })
      return card
    }

    // Priority 3: Scan skills/ directory
    const card = buildAgentCardFromSkills(agentDir, agentMeta, srv, servicePath)
    LOG.debug("Generated agent card from skills/", {
      service: srv.name,
      skills: card.skills.length,
    })
    return card
  }

  // Priority 4: CDS model (agentify mode)
  const card = buildAgentCardFromModel(srv, servicePath)
  LOG.debug("Generated agent card from CDS model", {
    service: srv.name,
    skills: card.skills.length,
  })
  return card
}

module.exports = { generateAgentCard, buildAgentCard, slugified }
