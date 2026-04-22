/**
 * @cap-js/a2a — Public API
 *
 * Exports for developers building custom executors or extending the plugin.
 */
module.exports = {
  CdsCheckpointSaver: require("./lib/persistence/checkpoint-saver").CdsCheckpointSaver,
  CdsTaskStore: require("./lib/persistence/task-store").CdsTaskStore,
}
