using {managed} from '@sap/cds/common';
using {Attachments} from '@cap-js/attachments';

namespace cap.agent;

/**
 * Framework-neutral conversation ledger shared by protocol and agent runtimes.
 * A2A task IDs are the IDs of the user messages that start those tasks.
 */
entity Messages : managed {
  key ID       : String;
      session  : String;
      sequence : Integer64;
      prev     : Association to Messages;
      role     : String;
      type     : String;
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
    key session         as ID,
        min(createdAt)  as createdAt,
        max(modifiedAt) as modifiedAt,
  }
  group by session;

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
