---
name: itinerary-export
description: >
  Return a completed itinerary as a machine-readable DataPart so a calling
  agent or program can consume it programmatically — not just as prose.
metadata:
  tags: [itinerary, datapart, structured, a2a, export, integration]
  examples:
    - Return the trip plan as structured data
    - Give me the itinerary as JSON I can ingest
    - Hand the booking back as machine-readable data
---

# Skill: Itinerary Export

The A2A protocol defines three Part types — TextPart, FilePart, and DataPart.
The other skills cover the first two: `itinerary-summary` returns a human-readable
TextPart, and `file-based-planning` returns a downloadable FilePart. This skill
covers the third: a **DataPart** — a structured object the caller consumes
programmatically, without parsing English.

## When to Use

- The caller is another **agent or program** (not a person reading prose) — e.g.
  an orchestrator that will book, store, or forward the plan automatically.
- The user explicitly asks for the itinerary "as data", "as JSON", "structured",
  or "machine-readable".
- A downstream system needs stable fields (confirmation IDs, prices, dates) it can
  index — where free-form text would be brittle to parse.

## Instructions

1. Plan and/or book the trip normally (see the `trip-planning` and
   `flight-booking` skills). Gather concrete flights, hotel, and activities with
   their prices and confirmation IDs.

2. Assemble a single structured object with a **stable shape** the caller can rely
   on:

   ```json
   {
     "origin": "New York",
     "destination": "Paris",
     "dates": { "depart": "2026-07-14", "return": "2026-07-21" },
     "currency": "USD",
     "flights": [
       {
         "airline": "Air France",
         "flightId": "AF007",
         "depart": "2026-07-14T18:30",
         "arrive": "2026-07-15T07:55",
         "price": 820,
         "confirmationId": "CONF-FL-001"
       }
     ],
     "hotel": {
       "name": "Hôtel Le Meurice",
       "stars": 5,
       "pricePerNight": 640,
       "checkIn": "2026-07-15",
       "checkOut": "2026-07-21",
       "confirmationId": "CONF-HT-001"
     },
     "activities": [
       {
         "name": "Louvre Guided Tour",
         "date": "2026-07-16",
         "price": 75,
         "confirmationId": "CONF-AC-001"
       }
     ],
     "totalCost": 5015
   }
   ```

3. Emit it as a DataPart with the `emit_data_part` tool:

   ```
   emit_data_part({ data: <the object above> })
   ```

   The executor republishes this as a `data-*` artifact on the A2A response, so a
   calling agent recovers the original object with the plugin's inbound
   `firstDataPart(parts)` utility — closing the agent-to-agent round-trip.

4. **Also give a short text summary.** The DataPart rides *alongside* the
   TextPart — it does not replace it. A human on the other end still gets a
   readable recap; a machine gets the structured object. Do not dump the raw JSON
   into your text answer — keep the prose human-friendly and let the DataPart carry
   the structure.

## Notes

- Prefer this over `emit_file_part` when the caller wants to *use* the data
  in-memory, not download a document. Use `file-based-planning` (FilePart) when the
  deliverable is a file for a human to open.
- Only include fields you actually have. Omit unknowns rather than inventing
  placeholder values — a consumer trusts the object's fields.
