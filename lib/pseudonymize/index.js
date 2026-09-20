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
  PD_ANNOTATIONS,
} from "./helpers.js"
import { SESSION_KEY } from "./helpers.js"

export function resolvePseudonyms(text) {
  if (typeof text !== "string") return text
  return cds.context?.[SESSION_KEY]?.resolveText(text) ?? text
}
