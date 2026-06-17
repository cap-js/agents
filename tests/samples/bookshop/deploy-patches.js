import fs from "fs"
import path from "path"

const mode = process.argv[2]
if (!mode || !["apply", "revert"].includes(mode)) {
  console.error("Usage: node deploy-patches.js <apply|revert>")
  process.exit(1)
}

const bookshopDir = import.meta.dirname
const rootPkg = path.resolve(bookshopDir, "../../../package.json")
const cdsFile = path.resolve(bookshopDir, "srv/agent-dev-service.cds")

if (mode === "apply") {
  const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf8"))
  delete pkg.workspaces
  fs.writeFileSync(rootPkg, JSON.stringify(pkg, null, 2) + "\n")

  let cds = fs.readFileSync(cdsFile, "utf8")
  cds = cds.replace("from '../../../../index.cds'", "from '@cap-js/agents/index'")
  fs.writeFileSync(cdsFile, cds)

  console.log("Deploy patches applied")
}

if (mode === "revert") {
  const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf8"))
  pkg.workspaces = ["tests/samples/bookshop/"]
  fs.writeFileSync(rootPkg, JSON.stringify(pkg, null, 2) + "\n")

  let cds = fs.readFileSync(cdsFile, "utf8")
  cds = cds.replace("from '@cap-js/agents/index'", "from '../../../../index.cds'")
  fs.writeFileSync(cdsFile, cds)

  const bookshopPkg = path.resolve(bookshopDir, "package.json")
  let bpkg = fs.readFileSync(bookshopPkg, "utf8")
  bpkg = bpkg.replace('"file:cap-js-agent-0.1.0.tgz"', '"file:../../../."')
  fs.writeFileSync(bookshopPkg, bpkg)

  console.log("Deploy patches reverted")
}
