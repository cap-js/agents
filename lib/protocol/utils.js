
/**
 * Attempt to reduce the verbose boilerplate of A2A updates
 */
export class SemanticEventBus {
  /** @param {import('@a2a-js/sdk/server').ExecutionEventBus} base */
  constructor(base, taskId, contextId) {
    this.base = base
    this.taskId = taskId
    this.contextId = contextId
  }

  /**
   * @param {import('@a2a-js/sdk').TaskStatus} status 
   */
  updateStatus(status) {
    return this.base.publish({
      kind: "task",
      id: this.taskId,
      contextId: this.contextId,
      status: { timestamp: new Date().toISOString(), ...status },
    })
  }

  /**
   * @param {import('@a2a-js/sdk').Artifact1} artifact
   * @param {boolean} final
   * @param {boolean} append
   */
  updateArtifact(artifact, final = false, append = false) {
    return this.base.publish({
      kind: "artifact-update",
      taskId: this.taskId,
      contextId: this.contextId,
      append: append,
      lastChunk: final,
      artifact,
    })
  }

  /**
   * @param {import('@a2a-js/sdk').Artifact1} artifact 
   */
  appendArtifact(artifact) {
    return this.updateArtifact(artifact, false, true)
  }

  /**
   * @param {import('@a2a-js/sdk').Artifact1} artifact 
   */
  finalArtifact(artifact) {
    return this.updateArtifact(artifact, true)
  }
}
