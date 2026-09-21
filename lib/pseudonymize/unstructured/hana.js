import cds from "@sap/cds"
import { PseudoSession } from "../store.js"
import { pseudonymizationThreadId } from "../structured/index.js"

const LOG = cds.log("agents")

// Full list of categories HANA detects: https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-predictive-analysis-library/descriptions-of-entity-types
const DPP_CATEGORIES = new Map([
  ["PERSON", "person"],
  ["URI:EMAIL", "email"],
  ["PHONE", "phone"],
  ["ADDRESS", "address"],
  ["URI:URL", "url"],
  ["URI:IP", "ip"],
])

let scriptServerActive

export async function anonymizeUserMessage(requestContext, serviceName) {
  if (!(await isScriptServerActive())) return

  const parts = requestContext.userMessage?.parts
  if (!Array.isArray(parts)) return
  const { contextId } = requestContext
  const session =
    cds.context?._pseudoSession ??
    (await PseudoSession.loadOrCreate(pseudonymizationThreadId(serviceName, contextId)))
  if (!session) return
  cds.context._pseudoSession = session

  const textParts = parts.filter((part) => part?.kind === "text" && part.text)
  const results = await Promise.all(textParts.map((part) => pseudonymizeText(part.text, session)))
  for (const [i, text] of results.entries()) {
    const part = textParts[i]
    if (text !== part.text) {
      part.text = text
    }
  }
}

async function isScriptServerActive() {
  if (scriptServerActive !== undefined) return scriptServerActive
  try {
    const rows = await cds.run(
      `SELECT "ACTIVE_STATUS" FROM "SYS"."M_SERVICES" WHERE "SERVICE_NAME" = 'scriptserver'`,
    )
    scriptServerActive = rows?.[0]?.ACTIVE_STATUS === "YES"
  } catch {
    scriptServerActive = false
  } finally {
    if (!scriptServerActive) {
      LOG.warn("HANA scriptserver / NLP not active — HANA Cloud based pseudonymization disabled")
    }
  }
  return scriptServerActive
}

async function pseudonymizeText(text, session) {
  const taskId = cds.context?.["agent.task.id"]
  const rawEntities = await cds.run(buildPalCallSql(), [taskId, text])
  // Store text analysis results in pseudoSession so it is part of graph state
  if (cds.context._pseudoSession._textAnalysisResults) {
    cds.context._pseudoSession._textAnalysisResults =
      cds.context._pseudoSession._textAnalysisResults.concat(rawEntities)
  } else {
    cds.context._pseudoSession._textAnalysisResults = rawEntities
  }
  const entities = rawEntities
    .filter((e) => e.TYPE === "ner" && e.ENTITY.some((ee) => DPP_CATEGORIES.has(ee)))
    .sort((a, b) => a.GLOBAL_OFFSET - b.GLOBAL_OFFSET)

  let result = text
  for (const row of entities) {
    if (result.slice(row.GLOBAL_OFFSET, row.GLOBAL_OFFSET + row.TOKEN.length) !== row.TOKEN)
      continue
    const pseudonym = session.pseudonymize(row.TOKEN, DPP_CATEGORIES.get(row.ENTITY))
    result = `${result.slice(0, row.GLOBAL_OFFSET)}${pseudonym}${result.slice(row.GLOBAL_OFFSET + row.TOKEN.length)}`
  }
  return result
}

function buildPalCallSql() {
  return `DO (IN text NVARCHAR(5000) => ?, OUT textAnalysisResults TABLE (ID NVARCHAR(36), "TYPE" NVARCHAR(3), SENTENCE_ID INTEGER, "TOKEN" NVARCHAR(5000), "ENTITY" NVARCHAR(1000), OFFSET INTEGER, GLOBAL_OFFSET INTEGER) => ?) BEGIN
    lt_data = SELECT CAST(SYSUUID as NVARCHAR(36)) AS "ID", :text AS "CONTENT", CAST('' AS NVARCHAR(1000)) AS "LANGUAGE", CAST('ner' AS NVARCHAR(20)) AS "TASK" FROM DUMMY UNION SELECT CAST(SYSUUID as NVARCHAR(36)) AS "ID", :text AS "CONTENT", CAST('' AS NVARCHAR(1000)) AS "LANGUAGE", CAST('pos' AS NVARCHAR(20)) AS "TASK" FROM DUMMY;
    lt_param = SELECT CAST('' AS NVARCHAR(256)) AS "PARAM_NAME", CAST(0 AS INTEGER) AS "INT_VALUE", CAST(0.0 AS DOUBLE) AS "DOUBLE_VALUE", CAST('' AS NVARCHAR(1000)) AS "STRING_VALUE" FROM DUMMY;
    CALL _SYS_AFL.PAL_TEXT_ANALYSIS(:lt_data, :lt_param, lt_sentences, lt_pos, lt_ner, lt_doc_sentiment, lt_sentence_sentiment, lt_phrase_sentiment, lt_extra);
    textAnalysisResults = 
      SELECT SYSUUID AS "ID", 'ner' AS "TYPE", "SENTENCE_ID", "TOKEN", "ENTITY", "OFFSET", "GLOBAL_OFFSET" FROM :lt_ner UNION  SELECT SYSUUID AS "ID", 'pos' AS "TYPE", "SENTENCE_ID", "TOKEN", "ENTITY", "OFFSET", "GLOBAL_OFFSET" FROM :lt_pos;
END;`
}
