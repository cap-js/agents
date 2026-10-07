import cds from "@sap/cds"

export async function loadPseudonymSession(session) {
  if (!session) return {}
  const { PseudonymMappings } = cds.entities("cap.agent")
  const rows = await cds.ql.SELECT`from ${PseudonymMappings} { hash, value }
    where session_ID = ${session} and createdBy = $user.id`
  return {
    seed: session,
    mappings: rows.map(({ hash, value }) => [hash, value]),
  }
}

export async function savePseudonymSession(session, store) {
  if (!session || !store) return
  const { PseudonymMappings } = cds.entities("cap.agent")
  const entries = [...store._hashToOriginal].map(([hash, value]) => ({
    session_ID: session,
    hash,
    value,
  }))
  if (entries.length) await UPSERT.into(PseudonymMappings).entries(entries)
}
