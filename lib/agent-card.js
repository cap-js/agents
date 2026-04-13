const cds = require("@sap/cds")
const { path } = cds.utils
const { getDescription, getFilteredEntities, getFilteredActions } = require("./utils")

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
 * Generate skills from entities and actions.
 */
function generateSkills(entities, actions) {
  const skills = []
  const entityNames = Object.keys(entities)

  // Entities → one "query" skill that covers all entities
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

  // Actions/functions => one skill each
  for (const [name, action] of Object.entries(actions)) {
    const description =
      getDescription(action) || `${action.kind === "function" ? "Get" : "Execute"} ${name}`

    const docExamples = getDocExamples(action)
    const examples = docExamples.length > 0 ? docExamples : [description]

    const tags = [name.toLowerCase(), action.kind]
    // actions need human approval, so we tag them as "hitl" (human-in-the-loop)
    // REVISIT: Another way to mark as hitl?
    if (action.kind === "action") tags.push("hitl")

    skills.push({
      id: name,
      name,
      description,
      examples,
      tags,
    })
  }

  return skills
}

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
    supportedInterfaces: [
      {
        url,
        protocolBinding: "JSONRPC",
        protocolVersion: "0.3.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  }
}

function generateAgentCard(srv, options = {}) {
  const servicePath = options.path || `/a2a/${slugified(srv.name)}`

  const card = buildAgentCard({
    name: srv.name,
    description: getDescription(srv.definition) || `Agent for ${srv.name}`,
    entities: getFilteredEntities(srv),
    actions: getFilteredActions(srv),
    url: servicePath,
  })

  LOG.debug("Generated agent card", { service: srv.name, skills: card.skills.length })

  return card
}

module.exports = { generateAgentCard, buildAgentCard, slugified }
