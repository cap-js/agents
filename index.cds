using {managed} from '@sap/cds/common';
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

entity Checkpoints : managed {
  key thread_id            : String;
  key checkpoint_ns        : String default '';
  key checkpoint_id        : String;
      parent_checkpoint_id : String;
      parent               : Association to one Checkpoints
                               on parent.checkpoint_id = parent_checkpoint_id;
      checkpoint           : LargeString;
      metadata             : LargeString;
      writes               : Composition of many CheckpointWrites
                               on  writes.thread_id     = thread_id
                               and writes.checkpoint_ns = checkpoint_ns
                               and writes.checkpoint_id = checkpoint_id;
}

entity CheckpointWrites {
  key thread_id     : String;
  key checkpoint_ns : String default '';
  key checkpoint_id : String;
      checkpoint    : Association to one Checkpoints
                        on  checkpoint.checkpoint_id = checkpoint_id
                        and checkpoint.checkpoint_ns = checkpoint_ns
                        and checkpoint.thread_id     = thread_id;
  key task_id       : String;
      task          : Association to one Tasks
                        on task.taskId = task_id;
  key idx           : Integer;
      channel       : String;
      value         : LargeString;
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
