import cds from "@sap/cds"
import { anonymize as hana } from "./hana.js"
import { anonymize as dpi } from "./dpi.js"
import { ensureSession } from "../index.js"

export default async function anonymizeUnstructured(text, seed) {
  const hanaResult = await hana(text, seed)
  const dpiResult = await dpi(hanaResult.text)
  return {
    text: dpiResult.text,
    mappings: [...(hanaResult.mappings ?? []), ...(dpiResult.mappings ?? [])],
    textAnalysisResults: hanaResult.textAnalysisResults,
  }
}

/**
 * Pseudonymize user message text parts before graph execution.
 */
export async function pseudonymizeUserMessage(srv, requestContext, checkpointer, threadId) {
  await ensureSession(checkpointer, threadId)
  const session = cds.context?.["agent.pseudonyms"]
  const parts = requestContext.userMessage?.parts
  if (!session || !Array.isArray(parts)) return

  const textParts = parts.filter((p) => (p.kind === "text" || (!p.kind && p.text)) && p.text)
  if (!textParts.length) return

  const results = await Promise.all(
    textParts.map((p) =>
      srv.send("pseudonymize", {
        data: p.text,
        type: "unstructured",
        seed: session._seed,
      }),
    ),
  )
  for (let i = 0; i < textParts.length; i++) {
    const r = results[i]
    textParts[i].text = r.data
    session.addMappings(r.mappings)
    if (r.metadata?.textAnalysisResults?.length) {
      session._textAnalysisResults = (session._textAnalysisResults ?? []).concat(
        r.metadata.textAnalysisResults,
      )
    }
    // Scrub any PII detected in prior turns that is not detected by HANA/DPI
    textParts[i].text = session.scrubText(textParts[i].text)
  }
}
