# Quota Enforcement

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

The plugin enforces configurable rate limits and resource quotas at two levels:

1. **Pre-request** — checked before graph execution starts. Returns HTTP `429` with `Retry-After` header.
2. **Per-node** — checked after each LLM iteration inside the graph. Fails the task with `state: "failed"`.

<details>
<summary>Configuration</summary>

All limits are configured via `cds.env.agents.pool` (defaults provided by the plugin):

```json
{
  "cds": {
    "agents": {
      "pool": {
        "maxConcurrentTasks": 10,
        "maxConcurrentTasksPerUser": 4,
        "maxTasksPerHour": 100,
        "maxTasksPerHourPerUser": 20,
        "maxLLMTokensPerDay": 5000000,
        "maxToolCallsPerHour": 1000,
        "maxToolCallsPerTask": 50,
        "maxLLMInvocationsPerTask": 50,
        "maxLLMTokensPerTask": 200000,
        "maxLLMCallTimeout": "120s",
        "maxExecutionTimePerTask": "5min",
        "timeoutGrace": "15s",
        "maxIncomingMessageLength": 5000
      }
    }
  }
}
```

</details>

<details>
<summary>Pre-Request Limits (HTTP 429)</summary>

| Limit                       | Retry-After        | Scope   |
| --------------------------- | ------------------ | ------- |
| `maxConcurrentTasks`        | 30s                | Tenant  |
| `maxConcurrentTasksPerUser` | 30s                | User    |
| `maxTasksPerHour`           | Next hour boundary | Tenant  |
| `maxTasksPerHourPerUser`    | Next hour boundary | User    |
| `maxToolCallsPerHour`       | Next hour boundary | Tenant  |
| `maxLLMTokensPerDay`        | Midnight UTC       | Tenant  |
| `maxIncomingMessageLength`  | — (HTTP 400)       | Request |

When exceeded, the response is:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1847
Content-Type: application/json

{"jsonrpc":"2.0","error":{"code":-32029,"message":"The maximum of 100 tasks per hour..."}}
```

</details>

<details>
<summary>Per-Task Limits (Task Failed)</summary>

| Limit                      | Checked at          | Effect                       |
| -------------------------- | ------------------- | ---------------------------- |
| `maxLLMInvocationsPerTask` | After each LLM call | Graph throws → task `failed` |
| `maxLLMTokensPerTask`      | After each LLM call | Same                         |
| `maxToolCallsPerTask`      | After each LLM call | Same                         |
| `maxLLMCallTimeout`        | Per LLM HTTP call   | Request aborted → error      |
| `maxExecutionTimePerTask`  | Timeout wrapper     | Graph throws → task `failed` |

</details>

<details>
<summary>LLM Circuit Breaker</summary>

Every LLM call is protected by a circuit breaker ([`@sap-cloud-sdk/resilience`](https://sap.github.io/cloud-sdk/docs/js/guides/resilience#circuit-breaker)) and a per-call timeout (`maxLLMCallTimeout`, default 120s). This prevents cascading failures when the LLM backend is degraded.

| Parameter        | Value                              | Description                                   |
| ---------------- | ---------------------------------- | --------------------------------------------- |
| Timeout          | `maxLLMCallTimeout` (120s default) | Individual HTTP call timeout                  |
| Error threshold  | 50%                                | Opens breaker if ≥50% of calls fail in window |
| Volume threshold | 10                                 | Minimum calls in window before evaluating     |
| Reset timeout    | 30s                                | Time before half-open test request            |

**Behavior:**

- 4xx responses (including 429 rate limits) do **not** trip the circuit breaker — only 5xx and network errors.
- When the breaker opens, all subsequent LLM calls fail immediately until the reset timeout elapses.
- After reset, one test request passes through (half-open). If successful, the breaker closes.
- The circuit breaker is always active — no opt-out configuration.

</details>
