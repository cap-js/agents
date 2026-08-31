# Data Privacy

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

## Data Retention

The plugin automatically triggers a cleanup of Tasks, and its related entities (Checkpoints, Files, A2A Push Notification configuration).

The TTL can be configured via `cds.agents.retention`. The default is 30 days and acceptable values are time strings like `30d` or raw millisecond values. Setting it to `false` or `0` disables it.

```json
{
  "cds": {
    "agents": {
      "retention": "30d"
    }
  }
}
```

For all tasks created within a 24h window for a specific Agent service, a single deletion is scheduled via `srv.schedule("cleanupTasks").after(TTL)`.

## Pseudonymization of Personal Data

When your CDS entities carry `@PersonalData` annotations, the plugin automatically pseudonymizes those fields before they reach the LLM — and before they are written to OTel traces. Users always see real values in the final response.

### Setup

Annotate fields in your CDS model:

```cds
entity Authors {
  key ID       : Integer;

  @PersonalData.IsPotentiallyPersonal
  name         : String;

  @PersonalData.IsPotentiallySensitive
  dateOfBirth  : Date;
}
```

The plugin handles the rest automatically:

- **LLM** sees `name_a8f3d2c1` instead of `"Emily Brontë"` — it reasons with the pseudonymous value but never sees real data.
- **User** receives the real value in the final response — hashes are resolved before the answer is returned.
- **OTel traces and MLflow** record hashed values by default, keeping telemetry DPP-compliant.
- **Multi-turn conversations** work across service instances — the same value always maps to the same hash within a session, and hashes are resolved back to originals before tool calls execute.

### Supported annotations

| Annotation                                      | Effect              |
| ----------------------------------------------- | ------------------- |
| `@PersonalData.IsPotentiallyPersonal`           | Field pseudonymized |
| `@PersonalData.IsPotentiallySensitive`          | Field pseudonymized |
| `@PersonalData.FieldSemantics: 'UserID'`        | Field pseudonymized |
| `@PersonalData.FieldSemantics: 'DataSubjectID'` | Field pseudonymized |

Applies to all field types except `Boolean`, `Date`, `DateTime`, and `Timestamp`.

### Opting out

If a field must be sent to the LLM as-is — for example a display name the LLM needs to include verbatim in its response — add `@agent.masking: false`. OTel traces are still scrubbed.

```cds
entity Contacts {
  @PersonalData.IsPotentiallyPersonal
  @agent.masking: false   // LLM sees the real value; trace still hashed
  displayName : String;
}
```

To disable pseudonymization entirely:

```json
{ "cds": { "agents": { "masking": false } } }
```

### Viewing real values in traces (dev/test)

Set `resolveInTraces: true` to see original values in OTel spans during development:

```json
{ "cds": { "agents": { "masking": { "resolveInTraces": true } } } }
```
