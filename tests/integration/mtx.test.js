import cds from "@sap/cds"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
axios.defaults.validateStatus = () => true

describe("Multi-tenancy (gauge metrics)", () => {
  it("does not scan subscribed tenants", async () => {
    const { computeGaugeMetrics, observeActiveUsers } =
      await import("../../lib/telemetry/gauge-metrics.js")

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

    // 2. Fail if active-user computation tries to connect to DeploymentService.
    const realConnect = cds.connect.to.bind(cds.connect)
    let deploymentServiceRequested = false
    cds.connect.to = async (name) => {
      if (name === "cds.xt.DeploymentService") {
        deploymentServiceRequested = true
        throw new Error("DeploymentService must not be used")
      }
      return realConnect(name)
    }

    try {
      await computeGaugeMetrics()

      const observed = []
      observeActiveUsers({ observe: (v, attrs) => observed.push({ value: v, attrs }) })

      expect(deploymentServiceRequested).toBe(false)
      expect(observed.length).toBeGreaterThan(0)
    } finally {
      cds.connect.to = realConnect
    }
  })

  it("falls back to current context tenant when DeploymentService is unavailable", async () => {
    const { computeGaugeMetrics, observeActiveUsers } =
      await import("../../lib/telemetry/gauge-metrics.js")

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
      await computeGaugeMetrics()
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
