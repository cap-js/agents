---
name: flight-booking
description: >
  Search, book, and cancel flights via the FlightService MCP server.
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

1. Always call `flights_describe` on the flights MCP first to learn the schema. The Flights entity is a denormalized view — field names differ from naive guesses.
2. Resolve city names to airport codes by calling `flights_query` on the `Airports` entity (e.g. "Paris" → CDG, ORY).
3. Call `flights_query` on the `Flights` entity filtered by departure/arrival airports and date.
4. Present options with airline, flight ID, time, and price.
5. When the user confirms, call `flights_bookFlight` with `{ flight, date, passenger, seats }`.
6. To cancel an existing booking, call `flights_cancelFlight` with the booking ID.

## Notes

- Do not invent airport codes — always verify them by querying the Airports entity.
- If a query fails with a schema error, re-read the output of `flights_describe` and retry with the correct field names.
