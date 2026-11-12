import cds from "@sap/cds"
import { readFileSync } from "node:fs"

export default function registerAppConfig(app) {
  const file = cds.utils.isfile(cds.root, "package.json")
  const pkg = file ? JSON.parse(readFileSync(file, "utf8")) : {}

  app.get("/app-config", (_req, response) => {
    const entities = Object.values(cds.services).flatMap((service) => {
      const endpoint = service.endpoints?.find((item) => item.kind === "hcql")
      if (!endpoint) return []
      return Object.entries(service.entities).map(([localName, entity]) => ({
        name: entity.name,
        localName,
        path: endpoint.path,
        dateTimeFields: Object.entries(entity.elements)
          .filter(([, field]) => field.type === "cds.DateTime")
          .map(([name]) => name),
        compositions: Object.entries(entity.elements)
          .filter(([, field]) => field.type === "cds.Composition")
          .map(([name]) => name),
      }))
    })
    const agent = Object.values(cds.services).find((service) => service.definition?.["@agent"])
    response.json({
      title: pkg.description || pkg.name,
      entities,
      agentPath: agent?.endpoints?.find((item) => item.kind === "agent")?.path,
    })
  })
}
