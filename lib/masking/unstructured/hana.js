import cds from "@sap/cds"

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

let scriptServerActive = true

export async function anonymizeUserMessage(text) {
  if (!scriptServerActive) return text
  if (!text) return text
  // Session is created by maskingMiddleware.beforeAgent before this is called.
  const session = cds.context?.["agent.pseudonyms"]
  try {
    const result = await pseudonymizeText(text, session)
    return result
  } catch (err) {
    LOG.error(`SAP HANA Cloud NLS based pseudonymization disabled due to error: `, err)
    scriptServerActive = false
    return text
  }
}

async function pseudonymizeText(text, session) {
  const res = await cds.run(buildPalCallSql(), [text])
  const entities = res.changes[1]
  // Accumulate text analysis results on the session to store it in session state
  if (session._textAnalysisResults) {
    session._textAnalysisResults = session._textAnalysisResults.concat(entities)
  } else {
    session._textAnalysisResults = entities
  }
  const piiEntities = entities
    .filter((e) => e.TYPE === "ner" && DPP_CATEGORIES.has(e.ENTITY))
    .sort((a, b) => a.GLOBAL_OFFSET - b.GLOBAL_OFFSET)

  let result = text
  for (const row of piiEntities) {
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
