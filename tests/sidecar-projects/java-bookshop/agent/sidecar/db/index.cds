// This file is needed because cds build --for hana needs an explicit entry point
// to compile the agent entities (Tasks, Checkpoints) into HANA artifacts.
// The plugin's index.cds is not picked up automatically at build time.
using from '@cap-js/agents';
