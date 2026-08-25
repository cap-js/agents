# Data Privacy

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

The plugin automatically triggers a cleanup of Tasks, and its related entities (Checkpoints, Files, A2A Push Notification configuration).

The TTL can be configured via `cds.agents.ttl`. The default is 30 days and acceptable values are time strings like `30d` or raw millisecond values.

```json
{
  "cds": {
    "agents": {
      "ttl": "30d"
    }
  }
}
```

For all tasks created within a 24h window for a specific Agent service, a single deletion is scheduled via `srv.schedule("cleanupTasks").after(TTL)`.

You can customize the deletion by overriding the handler:

```js
srv.on("cleanupTasks", async () => {
  //... own deletion logic
})
```
