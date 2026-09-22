import cds from "@sap/cds"

export function resolvePseudonyms(text) {
  if (typeof text !== "string") return text
  return cds.context?.["agent.pseudonyms"]?.resolveText(text) ?? text
}
