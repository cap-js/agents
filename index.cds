using {managed} from '@sap/cds/common';

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
