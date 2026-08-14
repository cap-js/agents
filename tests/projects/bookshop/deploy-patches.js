import fs from "fs"
import path from "path"

const mode = process.argv[2]
if (!mode || !["apply", "revert"].includes(mode)) {
  console.error("Usage: node deploy-patches.js <apply|revert>") // eslint-disable-line no-console
  process.exit(1)
}

const bookshopDir = import.meta.dirname
const rootPkgPath = path.resolve(bookshopDir, "../../../package.json")
const cdsFile = path.resolve(bookshopDir, "srv/agent-dev-service.cds")
const bookshopPkgPath = path.resolve(bookshopDir, "package.json")
const backupFile = path.resolve(bookshopDir, ".deploy-patches-backup.json")

if (mode === "apply") {
  const rootPkgOriginal = fs.readFileSync(rootPkgPath, "utf8")
  const bookshopPkgOriginal = fs.readFileSync(bookshopPkgPath, "utf8")
  const cdsOriginal = fs.readFileSync(cdsFile, "utf8")
  fs.writeFileSync(
    backupFile,
    JSON.stringify(
      { rootPkg: rootPkgOriginal, bookshopPkg: bookshopPkgOriginal, cds: cdsOriginal },
      null,
      2,
    ) + "\n",
  )

  const rootPkg = JSON.parse(rootPkgOriginal)
  delete rootPkg.workspaces
  fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n")

  const cds = cdsOriginal.replace("from '../../../../index.cds'", "from '@cap-js/agents/index'")
  fs.writeFileSync(cdsFile, cds)

  console.log("Deploy patches applied")
}

if (mode === "revert") {
  if (fs.existsSync(backupFile)) {
    const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"))
    if (backup.rootPkg) fs.writeFileSync(rootPkgPath, backup.rootPkg)
    if (backup.bookshopPkg) fs.writeFileSync(bookshopPkgPath, backup.bookshopPkg)
    if (backup.cds) fs.writeFileSync(cdsFile, backup.cds)
    fs.unlinkSync(backupFile)
  }

  // Clean up any packed tgz left in the bookshop dir
  for (const f of fs.readdirSync(bookshopDir)) {
    if (/^cap-js-agents-.*\.tgz$/.test(f)) fs.unlinkSync(path.join(bookshopDir, f))
  }

  console.log("Deploy patches reverted")
}
