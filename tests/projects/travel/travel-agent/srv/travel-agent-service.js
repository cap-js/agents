import cds from "@sap/cds"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

/**
 * Travel agent service implementation.
 *
 * The agent's behaviour is defined by markdown (AGENTS.md + skills/). The only
 * JS here demonstrates the recommended way to emit an A2A **DataPart**: the
 * plugin does NOT ship a generic emit tool (a DataPart is a contract with a
 * specific client), so the consumer defines its OWN tool, tailored to its data,
 * and returns the plugin's `dataPart()` wire helper from it.
 *
 * Any agent with a domain-specific structured payload follows the same shape:
 * swap the itinerary schema for your own, and the same mechanism ships that
 * object to the client as a `data-*` artifact.
 */
export default class TravelAgentService extends cds.ApplicationService {
  async init() {
    // Register a `buildTools` handler that ADDS our tailored tool on top of the
    // plugin's generated tools. `prepend` puts us first in the chain, so `next()`
    // reaches the plugin default and returns its tools for us to extend.
    this.prepend(() =>
      this.on("buildTools", async (_req, next) => {
        const tools = (await next()) ?? []
        tools.push(exportItineraryTool())
        return tools
      }),
    )

    return super.init()
  }
}

/**
 * Emit a structured itinerary as an A2A DataPart.
 */
function exportItineraryTool() {
  return tool(async ({ itinerary }) => ({ kind: "data", data: itinerary }), {
    name: "export_itinerary",
    description:
      "Return a completed itinerary as a machine-readable DataPart, so a calling " +
      "agent or program can ingest it programmatically. Pass the full itinerary " +
      "object as `itinerary`. The DataPart rides back alongside your text answer.",
    schema: z.object({
      itinerary: z.object({
        origin: z.string().optional(),
        destination: z.string().optional(),
        dates: z
          .object({
            depart: z.string().optional(),
            return: z.string().optional(),
          })
          .optional(),
        currency: z.string().optional(),
        flights: z
          .array(
            z.object({
              airline: z.string().optional(),
              flightId: z.string().optional(),
              depart: z.string().optional(),
              arrive: z.string().optional(),
              price: z.number().optional(),
              confirmationId: z.string().optional(),
            }),
          )
          .optional(),
        hotel: z
          .object({
            name: z.string().optional(),
            stars: z.number().optional(),
            pricePerNight: z.number().optional(),
            checkIn: z.string().optional(),
            checkOut: z.string().optional(),
            confirmationId: z.string().optional(),
          })
          .optional(),
        activities: z
          .array(
            z.object({
              name: z.string().optional(),
              date: z.string().optional(),
              price: z.number().optional(),
              confirmationId: z.string().optional(),
            }),
          )
          .optional(),
        totalCost: z.number().optional(),
      }),
    }),
  })
}
