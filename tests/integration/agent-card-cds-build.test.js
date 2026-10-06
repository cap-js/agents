import path from "node:path"
import { execSync, spawn } from "node:child_process"
import { rmSync } from "node:fs"
import cds from "@sap/cds"
import { serviceSourceDir } from "../../lib/utils/markdown.js"

const DEEP_AGENT_DIR = path.join(import.meta.dirname, "../projects/deep-agent")
const GEN_SRV_DIR = path.join(DEEP_AGENT_DIR, "gen", "srv")

rmSync(path.join(DEEP_AGENT_DIR, "gen"), { recursive: true, force: true })
execSync("cds build --production", { cwd: DEEP_AGENT_DIR, timeout: 60_000 })

afterAll(() => {
  rmSync(path.join(DEEP_AGENT_DIR, "gen"), { recursive: true, force: true })
})

describe("agent card from cds build output (gen/ folder)", () => {
  it("serviceSourceDir: prefers @source over $location after cds build", () => {
    const savedRoot = cds.root
    cds.root = GEN_SRV_DIR
    try {
      const fakeSrv = {
        definition: {
          "@source": "srv/colocated-agent/service.cds",
          get $location() {
            return { file: "srv/csn.json" }
          },
        },
      }
      const dir = serviceSourceDir(fakeSrv)
      expect(dir).toBe(path.join(GEN_SRV_DIR, "srv", "colocated-agent"))
      expect(dir).not.toBe(path.join(GEN_SRV_DIR, "srv"))
    } finally {
      cds.root = savedRoot
    }
  })

  it("cds watch from gen/srv produces no @agent.directory-not-found warning", async () => {
    const output = await new Promise((resolve, reject) => {
      const proc = spawn("cds", ["watch"], {
        cwd: GEN_SRV_DIR,
        env: {
          ...process.env,
          CDS_ENV: "test",
          NODE_ENV: "test",
          PORT: Math.round(Math.random() * 35000 + 5001),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      let buf = ""
      const collect = (chunk) => {
        buf += chunk.toString()
      }
      proc.stdout.on("data", collect)
      proc.stderr.on("data", collect)

      const check = setInterval(() => {
        if (/server listening/i.test(buf)) {
          clearInterval(check)
          clearTimeout(bail)
          proc.kill()
          resolve(buf)
        }
      }, 100)

      const bail = setTimeout(() => {
        clearInterval(check)
        proc.kill()
        reject(new Error(`cds watch did not reach 'server listening' in 20 s.\nOutput:\n${buf}`))
      }, 20_000)

      proc.on("error", (err) => {
        clearInterval(check)
        clearTimeout(bail)
        reject(err)
      })
    })

    expect(output).toMatch(/server listening/i)
    expect(output).not.toMatch(/@agent\.directory path not found/i)
    expect(output).not.toMatch(/falling back to convention/i)
  }, 30_000)
})
