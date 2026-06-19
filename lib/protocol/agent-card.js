import cds from "@sap/cds"
import { createRequire } from "node:module"
const { path } = cds.utils
import { getDescription, getFilteredEntities, getFilteredActions } from "../utils/utils.js"
import {
  scanSkills,
  parseAgentMetadata,
  parseAgentCardMd,
  parseAgentCardFile,
  slugified,
} from "../utils/markdown.js"

const require = createRequire(import.meta.url)

const LOG = cds.log("agent")

const FILE_IO_MIME_TYPES = [
  "text/csv",
  "application/json",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
]

/**
 * Merge fileIO MIME types into an agent card when cds.env.agents.fileIO.enabled is true.
 * defaultInputModes/defaultOutputModes are sufficient to advertise file transfer
 * capabilities to A2A clients — no capability extension is added.
 */
function applyFileIOCapability(card) {
  const cfg = cds.env.agents?.fileIO
  if (!cfg?.enabled) return card
  const inputMimes = cfg.defaultInputModes ?? FILE_IO_MIME_TYPES
  const outputMimes = cfg.defaultOutputModes ?? FILE_IO_MIME_TYPES
  const inputModes = [...new Set([...(card.defaultInputModes ?? []), ...inputMimes])]
  const outputModes = [...new Set([...(card.defaultOutputModes ?? []), ...outputMimes])]
  return { ...card, defaultInputModes: inputModes, defaultOutputModes: outputModes }
}

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
function buildAgentCard({ name, description, entities, actions, url, streaming = false }) {
  const skills = generateSkills(entities, actions)

  let version = "0.0.1"
  try {
    version = require(path.join(cds.root, "package.json")).version || version
  } catch {
    /* fallback */
  }

  return applyFileIOCapability({
    name,
    description,
    url,
    version,
    protocolVersion: "0.3.0",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "0.3.0" }],
    capabilities: { streaming, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  })
}

/**
 * Build agent card from CDS model (agentify mode, runtime).
 */
function buildAgentCardFromModel(srv, servicePath, streaming = false) {
  return buildAgentCard({
    name: srv.name,
    description: getDescription(srv.definition) || `Agent for ${srv.name}`,
    entities: getFilteredEntities(srv),
    actions: getFilteredActions(srv),
    url: servicePath,
    streaming,
  })
}

/**
 * Build agent card from AGENT_CARD.md (explicit card file).
 */
function buildAgentCardFromCardFile(cardMeta, agentMeta, srv, servicePath, streaming = false) {
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
    capabilities: cardMeta.metadata?.capabilities || { streaming, pushNotifications: false },
    defaultInputModes: cardMeta.defaultInputModes || ["text/plain"],
    defaultOutputModes: cardMeta.defaultOutputModes || ["text/plain"],
    skills,
  }
}

/**
 * Build agent card from skills/ directory scan.
 */
function buildAgentCardFromSkills(agentDir, agentMeta, srv, servicePath, streaming = false) {
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
    capabilities: { streaming, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  }
}

/**
 * Generate the A2A agent card for a service.
 *
 * Resolution chain (inputs supplied via the `resolved` parameter):
 *   1. `resolved.agentCardPath` — explicit path to agent card markdown
 *      (sourced from `@agent.card` annotation by the caller)
 *   2. `<resolved.agentDir>/AGENT_CARD.md` — convention within agent directory
 *   3. `<resolved.agentDir>/skills/` — auto-generated from SKILL.md frontmatter
 *   4. CDS model — entities + actions (agentify fallback)
 *
 * @param {object} srv      CDS ApplicationService
 * @param {object} [options] adapter options (e.g. `path`)
 * @param {object} [resolved] convention-resolved paths
 * @param {string} [resolved.agentDir]      absolute path to agent directory or undefined
 * @param {string} [resolved.agentCardPath] absolute path to explicit card file or undefined
 */
function generateAgentCard(srv, options = {}, resolved = {}) {
  const servicePath = options.path || `/a2a/${slugified(srv.name)}`
  const { agentDir, agentCardPath } = resolved
  const streaming = srv?.agent?.streaming ?? cds.env.agents?.streaming ?? true

  // Priority 1: Explicit agentCardPath (from @agent.card annotation)
  if (agentCardPath) {
    const cardMeta = parseAgentCardFile(agentCardPath)
    if (cardMeta) {
      const card = buildAgentCardFromCardFile(cardMeta, null, srv, servicePath, streaming)
      LOG.debug("Generated agent card from @agent.card annotation", {
        service: srv.name,
        path: agentCardPath,
        skills: card.skills.length,
      })
      return applyFileIOCapability(card)
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
      const card = buildAgentCardFromCardFile(cardMeta, agentMeta, srv, servicePath, streaming)
      LOG.debug("Generated agent card from AGENT_CARD.md", {
        service: srv.name,
        skills: card.skills.length,
      })
      return applyFileIOCapability(card)
    }

    // Priority 3: Scan skills/ directory
    const card = buildAgentCardFromSkills(agentDir, agentMeta, srv, servicePath, streaming)
    LOG.debug("Generated agent card from skills/", {
      service: srv.name,
      skills: card.skills.length,
    })
    return applyFileIOCapability(card)
  }

  // Priority 4: CDS model (agentify mode)
  const card = buildAgentCardFromModel(srv, servicePath, streaming)
  LOG.debug("Generated agent card from CDS model", {
    service: srv.name,
    skills: card.skills.length,
  })
  return applyFileIOCapability(card)
}

export { generateAgentCard, buildAgentCard }
