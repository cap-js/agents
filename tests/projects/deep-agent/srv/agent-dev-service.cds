using {
  cap.agent.Tasks,
  cap.agent.Sessions,
  cap.agent.Messages
} from '../../../../srv/entities';

service AgentDevService {
  entity AgentTasks            as projection on Tasks;
  entity AgentSessions      as projection on Sessions;
  entity AgentMessages as projection on Messages;
}
