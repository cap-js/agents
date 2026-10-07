import cds from "@sap/cds"

const MAPPINGS = "cap.agent.PseudonymMappings"
const userId = () => cds.context?.user?.id ?? "anonymous"

export async function loadPseudonymSession(session) {
  if (!session) return {}
  const rows = await SELECT.from(MAPPINGS)
    .columns("hash", "value")
    .where({ session_ID: session, createdBy: userId() })
  return {
    seed: session,
    mappings: rows.map(({ hash, value }) => [hash, value]),
  }
}

export async function savePseudonymSession(session, store) {
  if (!session || !store) return
  const entries = [...store._hashToOriginal].map(([hash, value]) => ({
    session_ID: session,
    hash,
    value,
    createdBy: userId(),
  }))
  if (entries.length) await UPSERT.into(MAPPINGS).entries(entries)
}
