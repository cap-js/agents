import cds from "@sap/cds"
import { PseudoSession } from "./store.js"
import { SESSION_KEY, pseudonymizationThreadId } from "./helpers.js"

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

export async function anonymizeUserMessage(requestContext, serviceName, contextId) {
  if (!(await isScriptServerActive())) return

  const parts = requestContext.userMessage?.parts
  if (!Array.isArray(parts)) return

  const session =
    cds.context?.[SESSION_KEY] ??
    (await PseudoSession.loadOrCreate(pseudonymizationThreadId(serviceName, contextId)))
  if (!session) return
  cds.context[SESSION_KEY] = session

  let changed = false
  const textParts = parts.filter((part) => part?.kind === "text" && part.text)
  const results = await Promise.all(textParts.map((part) => pseudonymizeText(part.text, session)))
  for (const [i, text] of results.entries()) {
    const part = textParts[i]
    if (text !== part.text) {
      part.text = text
      changed = true
    }
  }
  if (changed) await session.flush()
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
  await cds.run(buildPalCallSql(), [taskId, text])
  const entities = await SELECT.from("cap.agent.TextAnalysisResults")
    .columns("GLOBAL_OFFSET", "TOKEN", "ENTITY")
    .where({ taskId, type: "ner", entity: { in: [...DPP_CATEGORIES.keys()] } })
    .orderby("GLOBAL_OFFSET desc")

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
  return `DO (IN taskId NVARCHAR(36) => ?, IN text NVARCHAR(5000) => ?) BEGIN
    lt_data = SELECT :taskId AS "ID", :text AS "CONTENT", CAST('' AS NVARCHAR(1000)) AS "LANGUAGE", CAST('ner' AS NVARCHAR(20)) AS "TASK" FROM DUMMY;
    lt_param = SELECT CAST('' AS NVARCHAR(256)) AS "PARAM_NAME", CAST(0 AS INTEGER) AS "INT_VALUE", CAST(0.0 AS DOUBLE) AS "DOUBLE_VALUE", CAST('' AS NVARCHAR(1000)) AS "STRING_VALUE" FROM DUMMY;
    CALL _SYS_AFL.PAL_TEXT_ANALYSIS(:lt_data, :lt_param, lt_sentences, lt_pos, lt_ner, lt_doc_sentiment, lt_sentence_sentiment, lt_phrase_sentiment, lt_extra);
    INSERT INTO CAP_AGENT_TEXTANALYSISRESULTS ("ID", "TASKID", "TYPE", "SENTENCE_ID", "TOKEN", "ENTITY", "OFFSET", "GLOBAL_OFFSET")
      SELECT SYSUUID AS "ID", :taskId AS "TASKID", 'ner' AS "TYPE", "SENTENCE_ID", "TOKEN", "ENTITY", "OFFSET", "GLOBAL_OFFSET" FROM :lt_ner;
    INSERT INTO CAP_AGENT_TEXTANALYSISRESULTS ("ID", "TASKID", "TYPE", "SENTENCE_ID", "TOKEN", "ENTITY", "OFFSET", "GLOBAL_OFFSET")
      SELECT SYSUUID AS "ID", :taskId AS "TASKID", 'pos' AS "TYPE", "SENTENCE_ID", "TOKEN", "ENTITY", "OFFSET", "GLOBAL_OFFSET" FROM :lt_pos;
END;`
}
