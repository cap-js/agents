import cds from "@sap/cds"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
axios.defaults.validateStatus = () => true

describe("@cap-js/agents - Multi-tenancy (active_users)", () => {
  it("attributes tasks to the correct tenant via per-tenant iteration", async () => {
    const { computeActiveUsers, observeActiveUsers } =
      await import("../../lib/telemetry/active-users.js")

    // 1. Send a real message AS carol (mock-auth maps carol → tenant t1) so
    //    the task is persisted in t1's tenant pool.
    const res = await POST(
      "/a2a/catalog/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: cds.utils.uuid(),
            role: "user",
            parts: [{ kind: "text", text: "hello from t1" }],
          },
        },
      },
      { auth: { username: "carol", password: "" } },
    )
    expect(res.data.result?.status?.state).toBe("completed")

    // 2. Stub cds.connect.to and cds.spawn so:
    //    - DeploymentService.getTenants() returns ["t1"] (forces iteration branch)
    //    - cds.spawn() runs the callback in the CURRENT pool instead of opening
    //      a new tenant-isolated pool (so the SELECT sees the task we created
    //      against the current pool above).
    const realConnect = cds.connect.to.bind(cds.connect)
    const realSpawn = cds.spawn
    cds.connect.to = async (name) => {
      if (name === "cds.xt.DeploymentService") {
        return { getTenants: async () => ["t1"] }
      }
      return realConnect(name)
    }
    cds.spawn = (_opts, fn) => fn()

    try {
      await computeActiveUsers()

      const observed = []
      observeActiveUsers({ observe: (v, attrs) => observed.push({ value: v, attrs }) })

      const t1Entry = observed.find((o) => o.attrs["sap.tenantId"] === "t1")
      expect(t1Entry, "expected an entry for tenant t1").not.toBe(undefined)
      expect(t1Entry.value >= 1).toBeTruthy()
      // No "anonymous" — proves tenant resolved from iteration, not cds.context
      const anonEntry = observed.find((o) => o.attrs["sap.tenantId"] === "anonymous")
      expect(anonEntry).toBe(undefined)
    } finally {
      cds.connect.to = realConnect
      cds.spawn = realSpawn
    }
  })

  it("falls back to current context tenant when DeploymentService is unavailable", async () => {
    const { computeActiveUsers, observeActiveUsers } =
      await import("../../lib/telemetry/active-users.js")

    // Make sure we have at least one task
    const res = await POST("/a2a/catalog/", {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: cds.utils.uuid(),
          role: "user",
          parts: [{ kind: "text", text: "hello anonymous" }],
        },
      },
    })
    expect(res.data.result?.status?.state).toBe("completed")

    // Force the "no DeploymentService" path
    const realConnect = cds.connect.to.bind(cds.connect)
    cds.connect.to = async (name) => {
      if (name === "cds.xt.DeploymentService") throw new Error("not connected")
      return realConnect(name)
    }

    try {
      await computeActiveUsers()
      const observed = []
      observeActiveUsers({ observe: (v, attrs) => observed.push({ value: v, attrs }) })
      // In single-tenant fallback the tenant attr falls back to current
      // context (anonymous in cds.test default mock auth)
      const anonEntry = observed.find((o) => o.attrs["sap.tenantId"] === "anonymous")
      expect(anonEntry, "expected fallback entry").not.toBe(undefined)
    } finally {
      cds.connect.to = realConnect
    }
  })
})
