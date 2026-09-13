import cds from "@sap/cds"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

export default class TravelAgentService extends cds.ApplicationService {
  async init() {
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
