/**
 * Minimal @a2a service for MTX testing.
 * Uses mock executor (development profile) — no AI Core needed.
 */
@a2a
@description: 'MTX test agent'
service MtxTestService {
  entity Items {
    key ID : UUID;
    name   : String;
  }
}
