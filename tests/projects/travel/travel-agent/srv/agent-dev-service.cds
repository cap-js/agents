using { cap.agent.Messages } from '../../../../../srv/entities';

service AgentDevService {
  entity AgentMessages as projection on Messages;
}
