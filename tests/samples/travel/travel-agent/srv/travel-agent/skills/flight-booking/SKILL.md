---
name: flight-booking
description: >
  Search, book, and cancel flights via the xflights MCP server.
  Resolves airport codes, queries available flights, and confirms reservations.
metadata:
  tags: [flights, booking, mcp, airlines, airports]
  examples:
    - What flights are available from New York to Paris?
---

# Skill: Flight Booking

## When to Use

- User wants to search, book, or cancel a flight
- User mentions departure/arrival cities or airport codes
- A trip plan needs concrete flight options

## Instructions

1. Always call `describe` on the flights MCP first to learn the schema. The Flights entity is a denormalized view — field names differ from naive guesses.
2. Resolve city names to airport codes by querying `Airports` (e.g. "Paris" → CDG, ORY).
3. Query `Flights` filtered by departure/arrival airports and date.
4. Present options with airline, flight ID, time, and price.
5. When the user confirms, call `bookFlight` with `{ flight, date, passenger, seats }`.
6. To cancel an existing booking, call `cancelFlight` with the booking ID.

## Notes

- Do not invent airport codes — always verify them by querying the Airports entity.
- If a query fails with a schema error, re-read the output of `describe` and retry with the correct field names.
