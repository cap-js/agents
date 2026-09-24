---
name: file-based-planning
description: Read an uploaded CSV of travellers and produce a per-person itinerary saved to /outputs/.
---

# File-Based Planning

Use this skill when the user uploads a file containing traveller data and asks you to plan one or more trips from it.

## Workflow

### 1. Read the uploaded file

The file is available at `/uploads/<filename>`. Use `read_file` to retrieve its contents.

```
read_file('/uploads/trip-requests.csv')
```

Parse the CSV header row to identify columns (traveller, origin, destination, depart_date, return_date, budget_level, interests).

### 2. Identify the target traveller(s)

The user will usually ask you to plan for one specific person ("the first person", "Alice") or for all rows. Extract **only** the relevant row(s) — do not process other rows unless explicitly asked.

### 3. Search in parallel for each traveller

For each traveller run the full trip-planning search simultaneously. Use complete natural-language sentences when delegating to hotel and activity agents — include destination, dates, and budget in a single message:

- **Flights**: query MCP for flights from origin → destination on or near depart_date
- **Hotels**: `"Find hotels in <destination> for <depart_date>–<return_date>, <budget_level> budget."`
- **Activities**: `"Find <interests> activities in <destination>."`

### 4. Compose the itinerary

Write a Markdown itinerary that includes:

- Traveller name, route, dates, budget
- Best flight option (airline, departure/arrival, price)
- Best hotel option (name, rating, price per night)
- Recommended activities matching their interests
- Total estimated cost

### 5. Save to /outputs/

Write the itinerary using `write_file`. Use a descriptive filename based on the traveller's first name in lowercase:

```
write_file('/outputs/alice-plan.md', '<itinerary markdown>')
```

The file will be returned to the user as a downloadable attachment automatically.

### 6. Confirm to the user

Tell the user:

- The traveller name and destination covered
- That the plan has been saved (e.g. "Saved to alice-plan.md")
- A brief summary of the top picks
