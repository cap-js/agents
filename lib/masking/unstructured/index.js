import { anonymizeUserMessage as hana } from "./hana.js"
import { anonymizeUserMessage as dpi } from "./dpi.js"

export default async function anonymizeUserMessage(requestContext, serviceName) {
  await hana(requestContext, serviceName)
  await dpi(requestContext, serviceName)
}
