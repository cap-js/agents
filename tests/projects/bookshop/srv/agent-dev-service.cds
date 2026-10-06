using {
  cap.agent.Tasks,
  cap.agent.Checkpoints,
  cap.agent.CheckpointWrites
} from '../../../../srv/entities';

service AgentDevService {
  entity AgentTasks            as projection on Tasks;
  entity AgentCheckpoints      as projection on Checkpoints;
  entity AgentCheckpointWrites as projection on CheckpointWrites;
}
