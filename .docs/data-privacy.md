# Data Privacy

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

The plugin automatically triggers a cleanup of Tasks, and its related entities (Checkpoints, Files, A2A Push Notification configuration).

Configure TTL per service with `@agent.dataRetention`. Default is 30 days. Use time strings like `30d` or raw millisecond values. Set `false` or `0` to disable cleanup.

```cds
@agent.dataRetention: "30d"
service CatalogAgent {}
```

For all tasks created within a 24h window for a specific Agent service, a single deletion is scheduled via `srv.schedule("cleanupTasks").after(TTL)`.
