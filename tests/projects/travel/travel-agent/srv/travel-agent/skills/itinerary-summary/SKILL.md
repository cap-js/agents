---
name: itinerary-summary
description: >
  Summarize a complete travel itinerary — flights, hotels, and activities —
  with prices, dates, and confirmation IDs in a clean, scannable format.
metadata:
  tags: [itinerary, summary, travel, formatting]
  examples:
    - Summarize my trip
    - Show me the full itinerary
    - What did I book
---

# Skill: Itinerary Summary

## When to Use

- After all bookings (flights, hotels, activities) are confirmed
- User asks for a recap of what was booked
- End of a multi-turn trip-planning session

## Instructions

1. Group bookings by day in chronological order.
2. For each day include:
   - Flights (airline, flight ID, departure/arrival times, airports)
   - Hotel check-in/check-out
   - Scheduled activities (name, time, duration)
3. Show total estimated cost as a sum across all bookings.
4. List confirmation IDs for every booking so the user can reference them.
5. Keep the output concise — use bullet lists, no flowery prose.

## Format

```
Day 1 (YYYY-MM-DD)
  - Flight  XX123  HHmm → HHmm   (CONF-ID)
  - Hotel   <name> check-in       (CONF-ID)
  - Activity <name> HHmm-HHmm     (CONF-ID)

Total: <currency> <amount>
```
