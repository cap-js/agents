process.env.CDS_ENV = "with-mtx"

const cds = require("@sap/cds")
const { cleanDbFiles, startSidecar, stopSidecar, subscribeTenant, APP_DIR } = require("./setup")

jest.setTimeout(60000)

let sidecar

beforeAll(async () => {
  cleanDbFiles()
  sidecar = await startSidecar()
  const status = await subscribeTenant("t1", sidecar.port)
  expect(status).toBe(200)
})

afterAll(async () => {
  await stopSidecar(sidecar?.proc)
})

const { POST, axios } = cds.test(APP_DIR)
axios.defaults.validateStatus = () => true

// carol → t1 in default cds mock auth with multitenancy: true
const CAROL = { username: "carol", password: "" }

describe("@cap-js/a2a - Multi-tenancy (active_users)", () => {
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
    expect(res.data.result?.status?.state).toBe("completed")

    // Wait for scheduled computeActiveUsers to fire (interval: 1s)
    await new Promise((r) => setTimeout(r, 2000))

    // Check gauge reports tenant "t1" (not "anonymous")
    const { observeActiveUsers } = require("../../lib/telemetry/active-users")
    const observed = []
    observeActiveUsers({ observe: (value, attrs) => observed.push({ value, attrs }) })

    const t1Entry = observed.find((o) => o.attrs["sap.tenantId"] === "t1")
    expect(t1Entry).toBeDefined()
    expect(t1Entry.value).toBe(1)

    // No "anonymous" — proves tenant resolved from iteration, not cds.context
    const anonEntry = observed.find((o) => o.attrs["sap.tenantId"] === "anonymous")
    expect(anonEntry).toBeUndefined()
  })
})
