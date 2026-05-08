using {
  cap.a2a.Tasks,
  cap.a2a.Checkpoints,
  cap.a2a.CheckpointWrites
} from '../../../../index.cds';

service A2ADevService {
  entity A2ATasks            as projection on Tasks;
  entity A2ACheckpoints      as projection on Checkpoints;
  entity A2ACheckpointWrites as projection on CheckpointWrites;
}
