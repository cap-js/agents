#!/usr/bin/env node

import * as acorn from "acorn"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const ROOT = process.cwd()
const SOURCE_DIRS = ["lib", "srv"]
const DOC_PATH = path.join(ROOT, ".docs", "audit-logging.md")
const CHECK = process.argv.includes("--check")

const DETAILS_START = "<details>\n<summary>Events</summary>"
const DETAILS_END = "</details>"
const GENERATED_START = "<!-- audit-docs:start -->"
const GENERATED_END = "<!-- audit-docs:end -->"
const FIELD_ORDER = ["service", "taskId", "contextId"]

const files = SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).filter((file) =>
  file.endsWith(".js"),
)

const calls = files
  .flatMap(readAuditCalls)
  .sort((a, b) =>
    a.event === b.event
      ? a.file.localeCompare(b.file) || a.line - b.line
      : a.event.localeCompare(b.event),
  )

const currentDoc = fs.readFileSync(DOC_PATH, "utf8")
const nextDoc = updateDoc(currentDoc, calls)

if (CHECK) {
  if (nextDoc !== currentDoc) {
    console.error(".docs/audit-logging.md is out of date. Run npm run docs:audit.")
    process.exit(1)
  }
  console.log(".docs/audit-logging.md is up to date.")
} else {
  fs.writeFileSync(DOC_PATH, nextDoc)
  console.log(`Wrote ${path.relative(ROOT, DOC_PATH)} from ${calls.length} audit() call sites.`)
}

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(fullPath)
    if (entry.isFile()) return [fullPath]
    return []
  })
}

function readAuditCalls(file) {
  const source = fs.readFileSync(file, "utf8")
  const relativeFile = path.relative(ROOT, file)
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  })
  const result = []

  walkAst(ast, (node) => {
    if (node.type !== "CallExpression") return
    if (node.callee?.type !== "Identifier" || node.callee.name !== "audit") return

    const [eventNode, payloadNode] = node.arguments
    if (!isStringLiteral(eventNode)) return

    result.push({
      event: eventNode.value,
      file: relativeFile,
      line: node.loc.start.line,
      dataFields: objectPropertyFields(payloadNode, "data"),
      envelopeFields: objectFields(payloadNode).filter((field) => field !== "data"),
    })
  })

  return result
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") return
  visit(node)

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit)
    } else if (value && typeof value.type === "string") {
      walkAst(value, visit)
    }
  }
}

function isStringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string"
}

function objectPropertyFields(objectNode, propertyName) {
  if (objectNode?.type !== "ObjectExpression") return []
  const property = objectNode.properties.find(
    (prop) => prop.type === "Property" && propertyKey(prop) === propertyName,
  )
  return objectFields(property?.value)
}

function objectFields(node) {
  if (node?.type !== "ObjectExpression") return []
  return unique(node.properties.flatMap(fieldNameFromProperty).filter(Boolean))
}

function fieldNameFromProperty(property) {
  if (property.type === "SpreadElement") return fieldsFromSpreadArgument(property.argument)
  if (property.type !== "Property") return []
  const key = propertyKey(property)
  return key ? [key] : []
}

function fieldsFromSpreadArgument(node) {
  if (node?.type === "ObjectExpression") return objectFields(node).map((field) => `${field}?`)
  if (node?.type === "ConditionalExpression") {
    return unique([
      ...fieldsFromSpreadArgument(node.consequent),
      ...fieldsFromSpreadArgument(node.alternate),
    ])
  }
  if (node?.type === "LogicalExpression") return fieldsFromSpreadArgument(node.right)
  return ["...dynamic"]
}

function propertyKey(property) {
  if (property.computed) return null
  if (property.key.type === "Identifier") return property.key.name
  if (isStringLiteral(property.key)) return property.key.value
  return null
}

function updateDoc(doc, auditCalls) {
  const generated = generateSection(auditCalls)
  if (doc.includes(GENERATED_START) && doc.includes(GENERATED_END)) {
    const start = doc.indexOf(GENERATED_START)
    const end = doc.indexOf(GENERATED_END) + GENERATED_END.length
    return `${doc.slice(0, start)}${generated}${doc.slice(end)}`
  }

  const detailsStart = doc.indexOf(DETAILS_START)
  if (detailsStart === -1)
    return `${doc.trimEnd()}\n\n${DETAILS_START}\n\n${generated}\n\n${DETAILS_END}\n`

  const detailsEnd = doc.indexOf(DETAILS_END, detailsStart)
  if (detailsEnd === -1) throw new Error("Could not find closing </details> for Events section")

  return `${doc.slice(0, detailsStart)}${DETAILS_START}\n\n${generated}\n\n${doc.slice(detailsEnd)}`
}

function generateSection(auditCalls) {
  const byEvent = groupBy(auditCalls, (call) => call.event)
  const rows = Object.entries(byEvent)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([event, eventCalls]) => {
      const fields = unique(
        eventCalls.flatMap((call) => [...call.dataFields, ...call.envelopeFields]),
      ).sort(compareFields)
      return [`\`${event}\``, formatList(fields)]
    })

  const table = formatTable(["Event", "Fields"], rows)

  const callSites = auditCalls
    .map((call) => `- \`${call.event}\` - ${call.file}:${call.line}`)
    .join("\n")

  return `${GENERATED_START}

${table}

${GENERATED_END}`
}

function formatTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  )
  return [
    formatTableRow(headers, widths),
    formatTableRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
    ...rows.map((row) => formatTableRow(row, widths)),
  ].join("\n")
}

function formatTableRow(cells, widths) {
  return `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item)
    groups[key] ??= []
    groups[key].push(item)
    return groups
  }, {})
}

function unique(items) {
  return [...new Set(items)]
}

function formatList(items) {
  return items.length ? items.map((item) => `\`${item}\``).join(", ") : "-"
}

function compareFields(a, b) {
  const aIndex = FIELD_ORDER.indexOf(a)
  const bIndex = FIELD_ORDER.indexOf(b)
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  }
  return a.localeCompare(b)
}
