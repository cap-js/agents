/**
 * Shared utilities for tests that start CAP child-process servers
 * (xflights, leisure-services, etc.) and wait for them to be ready.
 *
 * Used by:
 *   tests/integration/external-tools.test.js
 *   tests/hybrid/travel-sample-e2e.test.js
 */
import { spawn } from "node:child_process"
import { readdirSync, unlinkSync } from "node:fs"
import { createConnection } from "node:net"
import path from "node:path"

/**
 * Check whether a TCP port is accepting connections on localhost.
 * Tries both 127.0.0.1 and ::1 to handle IPv4/IPv6 differences.
 */
export function isPortOpen(port) {
  const tryHost = (host) =>
    new Promise((resolve) => {
      const sock = createConnection({ port, host })
      let done = false
      const finish = (val) => {
        if (done) return
        done = true
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
        resolve(val)
      }
      sock.once("connect", () => finish(true))
      sock.once("error", () => finish(false))
      setTimeout(() => finish(false), 500)
    })
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then((rs) => rs.some(Boolean))
}

/**
 * Start a CAP server as a child process using `npx cds-serve`.
 * Resolves once the server is listening on the expected port.
 *
 * @param {string} cwd   - Directory of the CAP app to start
 * @param {number} port  - Expected listening port
 * @param {string} label - Human-readable label for error messages
 * @returns {Promise<import("node:child_process").ChildProcess>}
 */
export function startServer(cwd, port, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["cds-serve"], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "false", NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let output = ""
    const re = new RegExp(`server listening on \\{[^}]*url:\\s*'http:\\/\\/localhost:${port}'`)

    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `[${label}] Failed to start on port ${port} within 60s.\nOutput tail:\n${output.slice(-2000)}`,
        ),
      )
    }, 60_000)

    const onData = (chunk) => {
      output += chunk.toString()
      if (re.test(output)) {
        clearTimeout(timer)
        proc.stdout.off("data", onData)
        proc.stderr.off("data", onData)
        resolve(proc)
      }
    }

    proc.stdout.on("data", onData)
    proc.stderr.on("data", onData)
    proc.once("exit", (code) => {
      if (code != null && code !== 0) {
        clearTimeout(timer)
        reject(
          new Error(`[${label}] Exited with code ${code}.\nOutput tail:\n${output.slice(-2000)}`),
        )
      }
    })
  })
}

/**
 * Stop a child-process server and clean up any SQLite files it created.
 *
 * @param {import("node:child_process").ChildProcess|null} proc
 * @param {string} cwd - Directory to clean up SQLite files from
 */
export async function stopServer(proc, cwd) {
  if (!proc) return
  if (proc.exitCode == null) {
    proc.kill()
    await Promise.race([
      new Promise((resolve) => proc.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
  try {
    for (const f of readdirSync(cwd).filter((f) => /^db.*\.sqlite(-shm|-wal)?$/.test(f))) {
      try {
        unlinkSync(path.join(cwd, f))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Register process-level signal handlers to kill child processes on exit.
 * Call once per test file that starts child processes.
 *
 * @param {() => void} cleanup - Function that kills all child processes
 */
export function registerCleanupHandlers(cleanup) {
  process.on("exit", cleanup)
  process.on("SIGINT", () => {
    cleanup()
    process.exit(130)
  })
}
