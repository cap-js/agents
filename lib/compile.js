import cds from "@sap/cds"
import { slugified } from "./utils/utils.js"
import { compileAgentCard } from "./protocol/agent-card.js"
import { resolveAgentDir } from "./utils/markdown.js"

const A2A_BASE_PATH = "/a2a"

function cds_compile_to_a2a(csn, options = { service: undefined, hostUrl: undefined }) {
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

  let srv
  if (!options.service) {
    srv = services[0]
  } else {
    srv = services.find((s) => s.name === options.service)
    if (!srv) {
      throw new Error(`No service definition matching ${options.service} found in given model(s).`)
    }
  }

  // TODO: Why would url construction happen here instead of in compile?
  const customPath = srv["@path"]?.replace(/^\//, "")
  const servicePath = customPath ? customPath : slugified(srv.name)

  let hostUrl = (options.hostUrl ?? "").trim()
  if (hostUrl.length > 0 && !/^https?:\/\//i.test(hostUrl)) hostUrl = "https://" + hostUrl
  hostUrl = hostUrl.replace(/\/+$/, "")

  const agentDir = resolveAgentDir(srv)
  const url = `${hostUrl}${A2A_BASE_PATH}/${servicePath}`

  const agentCard = compileAgentCard(srv, agentDir, url)

  if (process.stdout.isTTY || options.as === "json") return agentCard
  else return JSON.stringify(agentCard, null, 2)
}

export default cds_compile_to_a2a
