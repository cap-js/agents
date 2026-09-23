import cds from "@sap/cds"
import { generatePseudonymTag } from "../store.js"

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

export async function anonymize(text, seed) {
  if (!scriptServerActive || !text || !seed) return { text }
  try {
    return await pseudonymizeText(text, seed)
  } catch (err) {
    LOG.error(`SAP HANA Cloud NLS based pseudonymization disabled due to error: `, err)
    scriptServerActive = false
    return { text }
  }
}

async function pseudonymizeText(text, seed) {
  const res = await cds.run(buildPalCallSql(), [text])
  const entities = res.changes[1]
  const piiEntities = entities
    .filter((e) => e.TYPE === "ner" && DPP_CATEGORIES.has(e.ENTITY))
    // Sort back to front so offsets stay valid after replacement
    .sort((a, b) => b.GLOBAL_OFFSET - a.GLOBAL_OFFSET)

  const mappings = []
  const seen = new Set()
  let result = text
  for (const row of piiEntities) {
    if (result.slice(row.GLOBAL_OFFSET, row.GLOBAL_OFFSET + row.TOKEN.length) !== row.TOKEN)
      continue
    const category = DPP_CATEGORIES.get(row.ENTITY)
    const tag = generatePseudonymTag(seed, row.TOKEN, category)
    result = `${result.slice(0, row.GLOBAL_OFFSET)}${tag}${result.slice(row.GLOBAL_OFFSET + row.TOKEN.length)}`
    if (!seen.has(row.TOKEN)) {
      seen.add(row.TOKEN)
      const hash = tag.slice(category.length + 1)
      mappings.push([tag, row.TOKEN])
      mappings.push([hash, row.TOKEN])
    }
  }
  return { text: result, mappings, textAnalysisResults: entities }
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
