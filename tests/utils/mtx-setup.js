import { spawn } from "child_process"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_DIR = path.join(__dirname, "app")
const SIDECAR_DIR = path.join(APP_DIR, "mtx", "sidecar")

function cleanDbFiles() {
  let files
  try {
    files = fs.readdirSync(APP_DIR)
  } catch {
    return
  }
  for (const f of files.filter((f) => /^db.*\.sqlite(-shm|-wal)?$/.test(f))) {
    try {
      fs.unlinkSync(path.join(APP_DIR, f))
    } catch {
      /* ignore */
    }
  }
}

/**
 * Start the MTX sidecar via `cds watch` on a random port.
 * Resolves with { proc, port } when the server is listening.
 */
function startSidecar() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["cds", "watch", "--port", "0"], {
      cwd: SIDECAR_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "false", NODE_ENV: "development" },
    })

    let output = ""
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Sidecar failed to start within 30s.\nOutput: ${output}`))
    }, 30000)

    proc.stdout.on("data", (data) => {
      output += data.toString()
      const match = output.match(/server listening on \{[^}]*url:\s*'http:\/\/localhost:(\d+)'/)
      if (match) {
        clearTimeout(timeout)
        resolve({ proc, port: Number(match[1]) })
      }
    })

    proc.stderr.on("data", (data) => {
      output += data.toString()
    })

    proc.on("exit", (code) => {
      clearTimeout(timeout)
      if (code !== null && code !== 0) {
        reject(new Error(`Sidecar exited with code ${code}.\nOutput: ${output}`))
      }
    })
  })
}

/**
 * Stop the sidecar process and clean up DB files.
 */
async function stopSidecar(proc) {
  if (proc && !proc.killed) {
    if (proc.exitCode !== null) {
      // already exited
    } else {
      proc.kill()
      await Promise.race([
        new Promise((resolve) => proc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
    }
  }
  cleanDbFiles()
}

/**
 * Subscribe a tenant via the sidecar's SaaS Provisioning endpoint.
 */
async function subscribeTenant(tenant, port) {
  const res = await fetch(`http://localhost:${port}/-/cds/saas-provisioning/tenant/${tenant}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from("yves:").toString("base64"),
    },
    body: JSON.stringify({
      subscribedTenantId: tenant,
      subscribedSubdomain: tenant,
    }),
  })
  return res.status
}

export { cleanDbFiles, startSidecar, stopSidecar, subscribeTenant, APP_DIR, SIDECAR_DIR }
