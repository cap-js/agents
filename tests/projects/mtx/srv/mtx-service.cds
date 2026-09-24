/**
 * Minimal @agent service for MTX testing.
 * Uses mock executor (development profile) — no AI Core needed.
 */
@agent
@description: 'MTX test agent'
service MtxTestService {
  entity Items {
    key ID : UUID;
    name   : String;
  }
}
