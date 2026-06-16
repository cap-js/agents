process.env.CDS_ENV = "with-mtx"

import assert from "node:assert/strict"
import cds from "@sap/cds"
import {
  cleanDbFiles,
  startSidecar,
  stopSidecar,
  subscribeTenant,
  APP_DIR,
} from "../utils/mtx-setup.js"

let sidecar

before(
  async () => {
    cleanDbFiles()
    sidecar = await startSidecar()
    const status = await subscribeTenant("t1", sidecar.port)
    assert.strictEqual(status, 200)
  },
  { timeout: 60000 },
)

after(async () => {
  await stopSidecar(sidecar?.proc)
})

const { POST, axios } = cds.test(APP_DIR)
axios.defaults.validateStatus = () => true

// carol → t1 in default cds mock auth with multitenancy: true
const CAROL = { username: "carol", password: "" }

describe("@cap-js/agent - Multi-tenancy (active_users)", () => {
  // TODO: This test requires proper CDS MTX sidecar ↔ app binding via ~/.cds-services.json.
  // The sidecar registers on startup, but cds.test() may boot the app before the binding is visible.
  // Works with manual `cds watch` but Jest orchestration needs further investigation.
  it.skip("should compute active_users with correct tenant from per-tenant query", async () => {
    // Send A2A message as tenant t1 user
    const res = await POST(
      "/a2a/mtx-test/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
      },
      { auth: CAROL },
    )
    assert.strictEqual(res.data.result?.status?.state, "completed")

    // Wait for scheduled computeActiveUsers to fire (interval: 1s)
    await new Promise((r) => setTimeout(r, 2000))

    // Check gauge reports tenant "t1" (not "anonymous")
    const { observeActiveUsers } = await import("../../lib/telemetry/active-users.js")
    const observed = []
    observeActiveUsers({ observe: (value, attrs) => observed.push({ value, attrs }) })

    const t1Entry = observed.find((o) => o.attrs["sap.tenantId"] === "t1")
    assert.notStrictEqual(t1Entry, undefined)
    assert.strictEqual(t1Entry.value, 1)

    // No "anonymous" — proves tenant resolved from iteration, not cds.context
    const anonEntry = observed.find((o) => o.attrs["sap.tenantId"] === "anonymous")
    assert.strictEqual(anonEntry, undefined)
  })
})
