import { anonymizeUserMessage as hana } from "./hana.js"
import { anonymizeUserMessage as dpi } from "./dpi.js"
import { ensureSession } from "../index.js"

export default async function anonymizeUserMessage(text, serviceName) {
  await ensureSession(serviceName)
  const afterHana = await hana(text)
  return await dpi(afterHana)
}
