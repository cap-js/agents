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

| Event | Fields |
| ----- | ------ |
| `AgentDecision` | `service`, `taskId`, `contextId`, `duration`, `iteration`, `model`, `tokenUsage`, `toolCalls` |
| `AgentInputRequired` | `service`, `taskId`, `contextId`, `description`, `interruptData` |
| `AgentTaskCanceled` | `service`, `taskId`, `contextId` |
| `AgentTaskCompleted` | `service`, `taskId`, `contextId`, `duration`, `task`, `tokenUsage`, `toolCalls` |
| `AgentTaskFailed` | `service`, `taskId`, `contextId`, `error`, `errorCode`, `task` |
| `AgentTaskResumed` | `service`, `taskId`, `contextId`, `decision` |
| `AgentTaskStarted` | `service`, `taskId`, `contextId`, `userMessage` |
| `ContentFilterBlocked` | `service`, `taskId`, `reason`, `source`, `user` |
| `IncomingMessageExceedingLength` | `service`, `forwardedIp`, `ip`, `message`, `user` |
| `QuotaExceeded` | `service`, `taskId`, `forwardedIp`, `ip`, `reason`, `user` |
| `ToolInvocation` | `service`, `taskId`, `args`, `duration`, `error?`, `outcome`, `tool` |
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
