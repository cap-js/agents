# Audit Logging

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

The plugin records immutable audit logs of agent decisions, actions, tool usage, and outcomes via [`@cap-js/audit-logging`](https://github.com/cap-js/audit-logging). All events are emitted as `SecurityEvent` for compatibility with the SAP Audit Log Service.

```bash
npm add @cap-js/audit-logging
```

In development, audit events are logged to the console. In production, they are sent to the SAP Audit Log Service via the transactional outbox.

<details>
<summary>Events</summary>

| Event                  | Trigger                         | Key Fields                                                                                        |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AgentTaskStarted`     | New task submitted              | `taskId`, `contextId`, `service`, `userMessage`                                                   |
| `AgentTaskResumed`     | HITL resume (approve/reject)    | `taskId`, `contextId`, `service`, `decision`, `userMessage`                                       |
| `AgentDecision`        | LLM invocation returns          | `taskId`, `service`, `model`, `iteration`, `toolCalls`, `inputTokens`, `outputTokens`, `duration` |
| `ToolInvocation`       | Tool executed                   | `taskId`, `service`, `tool`, `args`, `outcome`, `result`, `duration`                              |
| `AgentInputRequired`   | Agent requests human approval   | `taskId`, `contextId`, `service`, `description`, `userMessage`                                    |
| `AgentTaskCompleted`   | Task succeeds                   | `taskId`, `contextId`, `service`, `duration`, `tokens`, `toolCalls`, `output`, `task`             |
| `AgentTaskFailed`      | Task fails                      | `taskId`, `contextId`, `service`, `error`, `errorCode`, `task`                                    |
| `AgentTaskCanceled`    | Task canceled                   | `taskId`, `service`                                                                               |
| `QuotaExceeded`        | Quota breach                    | `action`, `service`, `user`, `reason`, `forwardedIp` + `ip` (top-level)                           |
| `ContentFilterBlocked` | Input blocked by content filter | `service`, `user`, `taskId`, `reason`, `source` (`user` or `tool`)                                |

All events include the original event name in the `data` field for filtering and forensic reconstruction. Common fields (`uuid`, `tenant`, `user`, `time`) are auto-filled by `@cap-js/audit-logging`. Every event also carries a `correlationId` (`cds.context.id`) for cross-referencing with auto-emitted DPP events.

</details>

<details>
<summary>Coverage</summary>

| Scenario                                                       | Audit coverage                                                                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in ReAct (`@agent` annotation)                           | Full — all events fire automatically                                                                                                                                         |
| Built-in Skill-based Agent (`@agent` annotation and AGENTS.md) | Full — all events fire automatically                                                                                                                                         |
| Custom graph (`buildGraph` event)                              | Full — task lifecycle, CDS tools, custom tools, and deepagents built-in tools are all covered automatically. LLM decisions covered if `config` carries `_taskId`/`_service`. |

</details>

<details>
<summary>Correlation</summary>

Events are correlated via `taskId`. For custom graphs, set `configurable._taskId` and `configurable._service` in your LangGraph config for full correlation. The plugin also sets `cds.context["agent.task.id"]` and `cds.context["agent.service"]` as fallback.

Every audit event includes a `correlationId` (`cds.context.id`) which is shared with auto-emitted DPP events. When a tool reads an entity annotated with `@PersonalData`, the `SensitiveDataRead` event emitted by `@cap-js/audit-logging` runs in the same CDS request context. Join on `correlationId` to trace which agent task and tool invocation triggered a personal data access.

</details>

<details>
<summary>Replay</summary>

With full audit trail, agent execution can be reconstructed:

```
AgentTaskStarted (taskId=abc)
  → AgentDecision (iteration=1, toolCalls=[query])
    → ToolInvocation (tool=query, args={entity:"Books"}, outcome=success)
  → AgentDecision (iteration=2, toolCalls=[])
AgentTaskCompleted (taskId=abc, duration=2.1s)
```

</details>
