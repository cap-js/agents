namespace cap.a2a;

/**
 * Stores A2A task objects for retrieval via tasks/get.
 */
entity Tasks {
  key taskId    : String; // A2A task ID (server-generated UUID)
      contextId : String; // Groups related tasks into conversations
      state     : String; // Current task state (submitted, working, completed, failed, etc.)
      data      : LargeString; // Full serialized A2A Task JSON
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
