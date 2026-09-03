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

<!-- audit-docs:start -->

| Event                            | Trigger                               | Fields                                                                                                                                    |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentDecision`                  | LLM invocation returns                | `service`, `taskId`, `contextId`, `duration`, `finishReason`, `iteration`, `model`, `modelParams?`, `provider`, `tokenUsage`, `toolCalls` |
| `AgentInputRequired`             | Agent requests human approval         | `service`, `taskId`, `contextId`, `description`, `interruptData`                                                                          |
| `AgentTaskCanceled`              | Task canceled                         | `service`, `taskId`, `contextId`                                                                                                          |
| `AgentTaskCompleted`             | Task succeeds                         | `service`, `taskId`, `contextId`, `duration`, `task`, `tokenUsage`, `toolCalls`                                                           |
| `AgentTaskFailed`                | Task fails                            | `service`, `taskId`, `contextId`, `error`, `errorCode`, `task`                                                                            |
| `AgentTaskResumed`               | HITL resume (approve/reject)          | `service`, `taskId`, `contextId`, `decision`                                                                                              |
| `AgentTaskStarted`               | New task submitted                    | `service`, `taskId`, `contextId`, `userMessage`                                                                                           |
| `ContentFilterBlocked`           | Input blocked by content filter       | `service`, `taskId`, `reason`, `source`, `user`                                                                                           |
| `IncomingMessageExceedingLength` | Incoming message exceeds length limit | `service`, `forwardedIp`, `ip`, `message`, `user`                                                                                         |
| `QuotaExceeded`                  | Quota breach                          | `service`, `taskId`, `forwardedIp`, `ip`, `reason`, `user`                                                                                |
| `ToolInvocation`                 | Tool executed                         | `service`, `taskId`, `args`, `duration`, `error?`, `outcome`, `tool`                                                                      |

<!-- audit-docs:end -->

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
