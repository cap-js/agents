import { DatabaseSync } from "node:sqlite"
import { execFile } from "node:child_process"
import { rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { promisify } from "node:util"

import { startServer, stopServer, registerCleanupHandlers } from "../utils/servers.js"

const BOOKSHOP_DIR = path.resolve(import.meta.dirname, "../projects/bookshop")
const DB_PATH = path.join(BOOKSHOP_DIR, "db.sqlite")
const PORT = 4700 + Math.floor(Math.random() * 500)
const execFileAsync = promisify(execFile)

let server

function runningTasks() {
  const db = new DatabaseSync(DB_PATH)
  try {
    return db
      .prepare(
        "SELECT start.ID as taskId FROM cap_agent_Messages start " +
          "WHERE start.role = 'user' AND start.type = 'text' " +
          "AND NOT EXISTS (SELECT 1 FROM cap_agent_Messages done " +
          "WHERE done.session = start.session AND done.sequence > start.sequence " +
          "AND done.role = 'ai' AND done.type IN ('failed', 'canceled', 'rejected')) " +
          "ORDER BY taskId",
      )
      .all()
  } finally {
    db.close()
  }
}

function taskState(taskId) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return db
      .prepare(
        "SELECT done.type FROM cap_agent_Messages start " +
          "JOIN cap_agent_Messages done ON done.session = start.session " +
          "AND done.sequence > start.sequence " +
          "WHERE start.ID = ? AND done.role = 'ai' " +
          "ORDER BY done.sequence DESC LIMIT 1",
      )
      .get(taskId)?.type
  } finally {
    db.close()
  }
}

async function waitFor(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let lastValue
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    lastValue = await predicate()
    if (lastValue) return lastValue
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for condition. Last value: " + JSON.stringify(lastValue))
}

async function startSlowTask() {
  const response = await fetch("http://127.0.0.1:" + PORT + "/a2a/slow-agent/", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/stream",
      params: {
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: "hold until server crash" }],
        },
      },
    }),
  })

  const reader = response.body.getReader()
  let buffer = ""
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read()
    if (done) {
      throw new Error(
        "Slow task stream ended before task ID arrived. HTTP " +
          response.status +
          ". Body: " +
          buffer,
      )
    }
    buffer += Buffer.from(value).toString("utf8")
    const match = buffer.match(/"id"\s*:\s*"([0-9a-f-]{36})"/)
    if (match) return { taskId: match[1], reader }
  }
}

// Crash-time persistence cannot be tested reliably because shutdown hooks do not await async work.
describe.skip("task recovery after server crash", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-shm", "-wal"]) rmSync(DB_PATH + suffix, { force: true })

    await execFileAsync("npx", ["cds", "deploy", "--to", "sqlite:db.sqlite"], {
      cwd: BOOKSHOP_DIR,
      env: { ...process.env, CDS_ENV: "test,crash-test", NODE_ENV: "test" },
    })

    registerCleanupHandlers(() => {
      if (server?.exitCode == null) server.kill()
    })

    server = await startServer(BOOKSHOP_DIR, PORT, "bookshop crash recovery", {
      env: { CDS_ENV: "test,crash-test", PORT: String(PORT) },
    })
  }, 30_000)

  afterAll(async () => {
    await stopServer(server, BOOKSHOP_DIR)
    server = null
  })

  it("marks running tasks failed across crash and restart", async () => {
    const { taskId, reader } = await startSlowTask()
    await waitFor(() => runningTasks().some((task) => task.taskId === taskId))

    await fetch("http://127.0.0.1:" + PORT + "/test/crash").catch(() => undefined)
    await waitFor(() => server.exitCode != null || runningTasks().length === 0)
    await waitFor(() => taskState(taskId) === "failed")
    await waitFor(() => runningTasks().length === 0)

    await reader.cancel().catch(() => undefined)
    await stopServer(server, BOOKSHOP_DIR, { cleanDb: false })
    server = await startServer(BOOKSHOP_DIR, PORT, "bookshop crash recovery restart", {
      env: { CDS_ENV: "test,crash-test", PORT: String(PORT) },
    })

    expect(runningTasks()).toEqual([])
  }, 45_000)
})
