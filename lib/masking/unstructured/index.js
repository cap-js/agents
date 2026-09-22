import { anonymizeUserMessage as hana } from "./hana.js"
import { anonymizeUserMessage as dpi } from "./dpi.js"
import { ensureSession } from "../index.js"

export default async function anonymizeUserMessage(requestContext, serviceName) {
  await ensureSession(serviceName)
  await hana(requestContext, serviceName)
  await dpi(requestContext, serviceName)
}
