import cds from "@sap/cds"

const A2A_BASE_PATH = "/a2a"

function slugified(name) {
  return /[^.]+$/.exec(name)[0]
    .replace(/Service$/, "")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, (_, c, C) => c + "-" + C)
    .toLowerCase()
}

function cds_compile_to_a2a(csn, options = {}) {
  const model = cds.linked(csn)
  const services = model.services

  if (services.length === 0)
    throw new Error("No service definitions found in given model(s).")

  if (!options.service && services.length > 1)
    throw new Error(
      `Found multiple service definitions in given model(s).` +
        `\nPlease choose by adding one of...${services.map((s) => `\n    -s ${s.name}`).join("")}`,
    )

  const def = options.service
    ? services.find((s) => s.name === options.service) ?? cds.error(`No service definition matching ${options.service} found in given model(s).`)
    : services[0]

  const servicePath = def["@path"]?.replace(/^\//, "") ?? slugified(def.name)
  const viaLink = def["@Core.Links"]?.find((l) => l.rel === "via")
  const url = viaLink?.href ?? `https://HOST${A2A_BASE_PATH}/${servicePath}`

  const card = {
    kind: "agent-card",
    name: def["@title"] ?? def.name,
    description: def["@description"] ?? "",
    url,
    version: "0.1",
    capabilities: { streaming: true },
  }

  if (/^(?:obj|object)$/i.test(options.as)) return card
  return JSON.stringify(card, null, 2)
}

export default cds_compile_to_a2a
