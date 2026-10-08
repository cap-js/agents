using {managed} from '@sap/cds/common';
using {Attachments} from '@cap-js/attachments';

namespace cap.agent;

type MessageRole : String enum {
  user;
  ai;
  system;
  tool;
};

type MessageType : String enum {
  // user, ai, and system messages
  text;
  // user messages
  decision;
  // ai messages
  tool_call;
  request;
  auth_required = 'auth-required';
  canceled;
  failed;
  rejected;
  // tool messages
  tool_result;
};

/**
 * Framework-neutral conversation ledger shared by protocol and agent runtimes.
 * A2A task IDs are the IDs of the user messages that start those tasks.
 */
entity Messages : managed {
  key ID       : UUID;
      session  : String;
      sequence : Integer64;
      prev     : Association to Messages;
      role     : MessageRole;
      type     : MessageType;
      content  : LargeString;
      query    : Map;
      agentService   : String;
      usageLlmTokens : Integer64 default 0;
      usageToolCalls : Integer default 0;

      /** Push notification configs for a task-anchoring user message. */
      pushConfigs    : Composition of many PushNotificationConfigs
                         on pushConfigs.task = $self;

      /** Files received with this message or emitted during its agent run. */
      inputFiles     : Composition of many Attachments;
      outputFiles    : Composition of many Attachments;
}

view Sessions as
  select from Messages {
    key session      as ID,
    key agentService,
        min(createdAt)  as createdAt,
        max(modifiedAt) as modifiedAt,
  }
  group by session, agentService;

@cds.api.ignore
view QuotaUsage as
  select from (
    select from Messages as message {
      createdAt,
      createdBy,
      usageToolCalls,
      usageLlmTokens,
      exists (
        select 1 from Messages as terminal
        where terminal.session = message.session
          and terminal.sequence > message.sequence
          and terminal.role = 'ai'
          and terminal.type in ('text', 'failed', 'canceled', 'rejected', 'auth-required')
      ) ? 0 : 1 as active
    }
    where message.role = 'user'
      and message.type = 'text'
      and date(message.createdAt) = date($now)
  ) as task {
    sum(task.active) as concurrentTasks,
    sum(seconds_between(task.createdAt, $now) <= 3600 ? 1 : 0) as lastHourTasks,
    sum(task.createdBy = $user.id ? task.active : 0) as concurrentTasksThisUser,
    sum(task.createdBy = $user.id and seconds_between(task.createdAt, $now) <= 3600 ? 1 : 0) as lastHourTasksThisUser,
    sum(seconds_between(task.createdAt, $now) <= 3600 ? task.usageToolCalls : 0) as lastHourToolCalls,
    sum(task.usageLlmTokens) as llmTokensThisDay
  };

/** Reversible pseudonym mappings require restricted retention and access handling. */
@cds.api.ignore
@PersonalData: {
  EntitySemantics: 'Other',
  DataSubjectRole: 'User'
}
entity PseudonymMappings : managed {
  key session : Association to one Sessions;
  key hash    : String @PersonalData.IsPotentiallyPersonal;
      value   : LargeString @PersonalData.IsPotentiallySensitive;
}

annotate PseudonymMappings with {
  createdBy @PersonalData.FieldSemantics: 'DataSubjectID';
};

/**
 * Stores push notification (webhook) configs registered by clients for task updates.
 *
 * REVISIT: A2A spec supports `authentication: { schemes: ["Bearer"], credentials: "..." }`
 * and `token` fields on PushNotificationConfig for authenticated callbacks. When needed:
 * 1. Add `schemes: String(512)` column (non-secret metadata, JSON array e.g. '["Bearer"]')
 * 2. Store token/credentials in SAP Credential Store — NOT in DB
 *    - Use @sap-cloud-sdk/connectivity getServiceBinding("credstore") for binding
 *    - Use @sap-cloud-sdk/http-client executeHttpRequest with mTLS destination
 *    - Throw at save-time if credstore not bound but secret provided (not at startup)
 * 3. Implement custom PushNotificationSender (6th arg to DefaultRequestHandler) that
 *    sends `Authorization: <scheme> <credentials>` header from authentication field
 *    and `X-A2A-Notification-Token` header from token field
 */
entity PushNotificationConfigs : managed {
  key task      : Association to one Messages;
  key configId  : String;
      url       : String(2048);
}
