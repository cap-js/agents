namespace cap.a2a;

/**
 * Stores A2A task objects for retrieval via tasks/get.
 */
entity Tasks {
  key taskId    : String;       // A2A task ID (server-generated UUID)
      contextId : String;       // Groups related tasks into conversations
      state     : String;       // Current task state (submitted, working, completed, failed, etc.)
      data      : LargeString;  // Full serialized A2A Task JSON
}
