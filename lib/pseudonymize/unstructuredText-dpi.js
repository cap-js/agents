import cds from "@sap/cds"
import { PseudoSession } from "./store.js"
import { SESSION_KEY } from "./helpers.js"

const PSEUDONYMIZE_PATH = "/anonymization/api/v1.0/unstructureddata/pseudonymize/text"
const TIMEOUT = 10_000
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

export async function anonymizeUserMessage(requestContext, serviceName, contextId) {
  const destinationName = resolveDestination()
  if (!destinationName) return
  const parts = requestContext.userMessage?.parts
  if (!Array.isArray(parts)) return

  const session =
    cds.context?.[SESSION_KEY] ?? (await PseudoSession.loadOrCreate(`${serviceName}:${contextId}`))
  if (!session) return
  cds.context[SESSION_KEY] = session

  let changed = false
  const textParts = parts.filter((part) => part?.kind === "text" && part.text)
  const results = await Promise.all(
    textParts.map((part) => anonymizeText(part.text, destinationName)),
  )
  for (const [i, result] of results.entries()) {
    const part = textParts[i]
    for (const { original, pseudonym } of result.mappings ?? []) {
      session.remember(original, pseudonym)
    }
    if (result.text !== part.text) {
      part.text = result.text
      changed = true
    }
  }
  if (changed) await session.flush()
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
  return {
    text: data.result,
    mappings: extractPseudonymMappings(data.metadata),
  }
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
  for (const pseudonym of Object.keys(data)) {
    mappings.push({ original: data[pseudonym].real_entity, pseudonym })
    // LLM will use the plain UUID in queries and not the whole tag
    const UUID = pseudonym.match(/:([^>]+)>/)?.[1]
    if (UUID) {
      mappings.push({ original: data[pseudonym].real_entity, pseudonym: UUID })
    }
  }
  return mappings
}
// API Docs: https://api.sap.com/api/sap-dpi-pseudonymization-v1/resource/Pseudonymization
// SAP Help: https://help.sap.com/docs/data-privacy-integration/development/api-endpoints-9956053a4e6447cfbaccb9d2dee35c11
async function postToDpi(payload, destinationName) {
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
