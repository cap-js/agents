/**
 * Tests for AICore destination-based connectivity.
 *
 * Verifies that when `destinationName` is configured, the SDK receives
 * the correct destination and deploymentConfig (resourceGroup) parameters
 * instead of relying on a service binding (VCAP_SERVICES).
 */
import cds from "@sap/cds"
import InstrumentedOrchestrationClient from "../../lib/models/aicore.js"

cds.test(import.meta.dirname + "/../samples/bookshop")

const MODEL_NAME = "anthropic--claude-4.6-sonnet"

describe("@cap-js/agents - AICore Destination Connectivity", () => {
  describe("constructor - destination parameters", () => {
    it("sets destination when destinationName is provided", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        contentFilter: false,
      })
      expect(model.destination).toEqual({ destinationName: "my-aicore-dest" })
    })

    it("sets deploymentConfig with default resourceGroup when destinationName provided", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        contentFilter: false,
      })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "default" })
    })

    it("uses explicit resourceGroup when provided with destinationName", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        resourceGroup: "my-custom-group",
        contentFilter: false,
      })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "my-custom-group" })
    })

    it("sets resourceGroup without destination when only resourceGroup is provided", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        resourceGroup: "custom-group",
        contentFilter: false,
      })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "custom-group" })
      expect(model.destination).toBeUndefined()
    })

    it("leaves destination and deploymentConfig undefined when neither configured", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        contentFilter: false,
      })
      expect(model.destination).toBeUndefined()
      expect(model.deploymentConfig).toBeUndefined()
    })

    it("preserves all other constructor behavior when destination is configured", () => {
      const model = new InstrumentedOrchestrationClient(MODEL_NAME, {
        model: MODEL_NAME,
        destinationName: "my-aicore-dest",
        params: { temperature: 0.5, max_tokens: 2048 },
        contentFilter: true,
      })
      // orchestrationConfig still set correctly
      expect(model.orchestrationConfig.promptTemplating.model.name).toBe(MODEL_NAME)
      expect(model.orchestrationConfig.promptTemplating.model.params).toEqual({
        temperature: 0.5,
        max_tokens: 2048,
      })
      // content filter still applied
      expect(model.orchestrationConfig.filtering).toBeDefined()
      expect(model.orchestrationConfig.filtering.output).toBeDefined()
    })
  })

  describe("buildModel integration - destination via cds.requires", () => {
    let srv, savedHandlers

    beforeAll(async () => {
      srv = await cds.connect.to("CatalogService")
    })

    beforeEach(() => {
      savedHandlers = [...(srv.handlers?.on || [])]
    })

    afterEach(() => {
      if (srv.handlers?.on) srv.handlers.on.length = 0
      if (srv.handlers?.on && savedHandlers) srv.handlers.on.push(...savedHandlers)
    })

    it("passes destinationName from config options to model", async () => {
      srv.prepend((s) =>
        s.on(
          "buildModel",
          () =>
            new InstrumentedOrchestrationClient(MODEL_NAME, {
              model: MODEL_NAME,
              destinationName: "prod-aicore",
              resourceGroup: "agents",
              contentFilter: false,
            }),
        ),
      )
      const model = await srv.send("buildModel", {})
      expect(model.destination).toEqual({ destinationName: "prod-aicore" })
      expect(model.deploymentConfig).toEqual({ resourceGroup: "agents" })
    })
  })
})
