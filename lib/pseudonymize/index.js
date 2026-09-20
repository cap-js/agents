import cds from "@sap/cds"

export { PseudoSession } from "./store.js"
export {
  shouldHash,
  personalDataElements,
  discoverElementsToBeMasked,
  actionReturnElements,
  hasPersonalDataAnnotations,
  pseudonymizeData,
  resolveArgs,
  pseudonymizeToolResult,
  pseudonymizationThreadId,
} from "./structured/index.js"

export function resolvePseudonyms(text) {
  if (typeof text !== "string") return text
  return cds.context?._pseudoSession?.resolveText(text) ?? text
}
