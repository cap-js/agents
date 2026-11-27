using {cuid, managed} from '@sap/cds/common';
using {Attachments} from '@cap-js/attachments';

namespace cap.agent;

/**
 * Stores A2A task objects for retrieval via tasks/get.
 */
entity Tasks : managed {
      /**
       * A2A task ID (server-generated UUID)
       */
  key taskId         : String;
      /**
       * Groups related tasks into conversations
       */
      contextId      : String;
      /**
       * Current task state (submitted, working, completed, failed, etc.)
       */
      state          : String;
      /**
       * Full serialized A2A Task JSON
       */
      data           : LargeString;
      /**
       * Fully qualified CDS service name
       */
      agentService   : String;
      /**
       * Combined LLM Input and Output tokens used for this task
       */
      usageLlmTokens : Integer64 default 0;
      /**
       * Amount of tool calls made by this task
       */
      usageToolCalls : Integer default 0;

      /** Push notification (webhook) configs for this task. Cascade-deleted. */
      pushConfigs    : Composition of many PushNotificationConfigs
                         on pushConfigs.taskId = taskId;

      /**
       * Files received from user or downstream agents for this task.
       * Conversation-scoped reads use up_.contextId path expression.
       */
      inputFiles     : Composition of many Attachments;

      /**
       * Files written by agent via /outputs/ path for this task.
       */
      outputFiles    : Composition of many Attachments;

}

/** Owner-scoped session rows coordinate concurrent message appends. */
entity Sessions : cuid, managed {
  key owner    : String;
      sequence : Integer64; // Last allocated message sequence; initialized once for existing sessions.
      messages : Composition of many Messages
                   on messages.session = ID and messages.createdBy = owner;
}

@assert.unique.sequence: [session, createdBy, sequence]
@assert.unique.order: [createdBy, category, sortKey, ID]
@assert.unique.scopeOrder: [createdBy, category, scope, sortKey, ID]
@assert.unique.streamOrder: [createdBy, category, scope, stream, sortKey, ID]
@assert.unique.streamSequence: [createdBy, category, scope, stream, sequence, ID]
@assert.unique.parent: [createdBy, prev, ID]
entity Messages : cuid, managed {
  session  : UUID; // A2A contextId — groups messages into a conversation
  sequence : Integer64;
  scope    : UUID; // Generic logical collection, independent of the adapter's identifiers.
  stream   : UUID;
  category : String(32);
  sortKey  : String(512);
  @assert.integrity: false // History may refer to an archived or not-yet-written message.
  prev     : Association to Messages;
  role     : RoleType;
  type     : MessageType;
  content  : LargeString;
  query    : Map;
}

type RoleType : String enum {
  user;
  assistant;
  system;
  tool;
};

type MessageType : String enum {
  text;
  image;
  file;
  tool_call;
  tool_result;
  reasoning;
  data;
  approve;
  reject;
}

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
  key taskId    : String;
  key configId  : String;
      task      : Association to one Tasks on task.taskId = taskId;
      url       : String(2048);
}
