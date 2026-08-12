---
name: trip-planning
description: >
  Plan a complete trip by coordinating flights, hotels, and activities.
  Searches all domains in parallel and presents options to the user.
metadata:
  tags: [travel, planning, trips, flights, hotels, activities]
  examples:
    - Plan a weekend trip to Paris
    - I want to visit Tokyo for 5 days
    - Book me a getaway to Barcelona next month
---

# Skill: Trip Planning

## When to Use

- User asks to plan a trip, vacation, or weekend getaway
- User mentions a destination and wants help organizing travel

## Instructions

1. Identify the destination and dates (use reasonable defaults if not specified)
2. Search in parallel:
   - Call the hotel agent with a natural language description of what's needed
   - Call the activity agent with a natural language description of interests
   - Call `flights_describe` on the flights MCP to learn the schema, then query airports for the destination city
3. Once you have airport codes, query available flights
4. Present options to the user with prices and details
5. When the user decides, make all bookings (flights via MCP `flights_bookFlight`, hotels/activities via A2A agents)
6. Summarize the complete itinerary at the end
