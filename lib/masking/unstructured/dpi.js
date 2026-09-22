import cds from "@sap/cds"
import { PseudonymStore } from "../store.js"

const PSEUDONYMIZE_PATH = "/anonymization/api/v1.0/unstructureddata/pseudonymize/text"
const TIMEOUT = 30_000
const DEFAULT_ENTITIES = [
  "profile-person",
  "profile-email",
  "profile-phone",
  "profile-address",
  "profile-username-password",
  "profile-nationalid",
  "profile-iban",
  "profile-ssn",
  "profile-credit-card-number",
  "profile-passport",
  "profile-driverlicense",
]

export async function anonymizeUserMessage(text) {
  const destinationName = resolveDestination()
  if (!destinationName) return text
  if (!text) return text
  // Session is created by maskingMiddleware.beforeAgent before this is called.
  const session = cds.context?.["agent.pseudonyms"]
  const result = await anonymizeText(text, destinationName)
  for (const { original, pseudonym } of result.mappings ?? []) {
    session.remember(original, pseudonym)
  }
  return result.text
}

function resolveDestination() {
  const required = cds.env.requires?.["data-anonymization"]
  const destinationName = required?.credentials?.destination
  if (!destinationName) return undefined
  return destinationName
}

async function anonymizeText(text, destinationName) {
  const payload = buildPayload(text)
  const data = await postToDpi(payload, destinationName)
  const mappings = extractPseudonymMappings(data.metadata)
  // Rewrite DPI tags in the anonymized text from <<profile-person>:hash> to person-hash.
  const result = data.result.replace(/<<(?:profile-)?([^>]+)>:([^>]+)>/g, "$1-$2")
  return { text: result, mappings }
}

function buildPayload(text) {
  const payload = new URLSearchParams()
  payload.set("text", text)
  payload.set("entities", DEFAULT_ENTITIES.join(";"))
  payload.set("anonymization-method-per-profile", "")
  payload.set("whitelist", "")
  payload.set("enable-default-whitelist", "false")
  return payload.toString()
}

function extractPseudonymMappings(data) {
  const mappings = []
  // DPI returns pseudonyms in the form "<<profile-person>:abc12345>".
  // Convert to the standard tag format "person-abc12345" and also register
  // the bare hash "abc12345" so the LLM can use it in queries.
  for (const dpiTag of Object.keys(data)) {
    const match = dpiTag.match(/^<<(?:profile-)?([^>]+)>:([^>]+)>$/)
    if (!match) continue
    const [, entityType, hash] = match
    const tag = `${entityType}-${hash}`
    const original = data[dpiTag].real_entity
    mappings.push({ original, pseudonym: tag })
    mappings.push({ original, pseudonym: hash })
  }
  return mappings
}
// API Docs: https://api.sap.com/api/sap-dpi-pseudonymization-v1/resource/Pseudonymization
// SAP Help: https://help.sap.com/docs/data-privacy-integration/development/api-endpoints-9956053a4e6447cfbaccb9d2dee35c11
async function postToDpi(payload, destinationName) {
  const { getDestination } = await import("@sap-cloud-sdk/connectivity")
  const destination = await getDestination({ destinationName })
  const { executeHttpRequest } = await import("@sap-cloud-sdk/http-client")
  const response = await executeHttpRequest(
    { destinationName },
    {
      method: "post",
      url: `${PSEUDONYMIZE_PATH}?priority=high`,
      data: payload,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      timeout: TIMEOUT,
    },
    { fetchCsrfToken: false },
  )
  return response.data
}
