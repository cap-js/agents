using { managed } from '@sap/cds/common';
namespace cap.a2a;

/**
 * Stores A2A task objects for retrieval via tasks/get.
 */
entity Tasks : managed {
  key taskId    : String; // A2A task ID (server-generated UUID)
      contextId : String; // Groups related tasks into conversations
      state     : String; // Current task state (submitted, working, completed, failed, etc.)
      data      : LargeString; // Full serialized A2A Task JSON
      /**
       * Fully qualified CDS service name
       */
      agent_service: String;
      /**
       * Combined LLM Input and Output tokens used for this task
       */
      usage_llm_tokens: Integer64 default 0;
      /**
       * Amount of tool calls made by this task
       */
      usage_tool_calls: Integer default 0;
}

entity Checkpoints {
  key thread_id            : String;
  key checkpoint_ns        : String default '';
  key checkpoint_id        : String;
      parent_checkpoint_id : String;
      checkpoint           : LargeString;
      metadata             : LargeString;
}

entity CheckpointWrites {
  key thread_id     : String;
  key checkpoint_ns : String default '';
  key checkpoint_id : String;
  key task_id       : String;
  key idx           : Integer;
      channel       : String;
      value         : LargeString;
}
