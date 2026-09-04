import cds from "@sap/cds"
import { getDescription, getFilteredEntities, getFilteredActions, slugified } from "./utils/utils.js"
import { buildAgentCard } from "./protocol/agent-card.js"

const A2A_BASE_PATH = "/a2a"

function cds_compile_to_a2a(csn, options = {}) {
  const model = cds.linked(csn)
  const services = model.services

  if (services.length === 0) {
    throw new Error("No service definitions found in given model(s).")
  }

  if (!options.service && services.length > 1) {
    throw new Error(
      `Found multiple service definitions in given model(s).` +
        `\nPlease choose by adding one of...${services.map((s) => `\n    -s ${s.name}`).join("")}`,
    )
  }

  let def
  if (!options.service) {
    def = services[0]
  } else {
    def = services.find((s) => s.name === options.service)
    if (!def) {
      throw new Error(`No service definition matching ${options.service} found in given model(s).`)
    }
  }

  // Build service path — respect @path annotation, otherwise use slugified name
  const customPath = def["@path"]
  const servicePath = customPath ? customPath.replace(/^\//, "") : slugified(def.name)

  // If service is behind a proxy, @Core.Links with rel='via' provides the proxy URL
  const viaLink = def["@Core.Links"]?.find((l) => l.rel === "via")
  const url = viaLink?.href ?? `https://HOST${A2A_BASE_PATH}/${servicePath}`

  const agentCard = buildAgentCard({
    name: def.name,
    description: getDescription(def, "en") || `Agent for ${def.name}`,
    entities: getFilteredEntities(def),
    actions: getFilteredActions(def),
    url,
    streaming: true,
  })

  if (/^(?:obj|object)$/i.test(options.as)) return agentCard

  return JSON.stringify(agentCard, null, 2)
}

export default cds_compile_to_a2a
