using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Pi-harness agent service for pi-executor integration tests.
 */
@agent
@description: 'Pi-harness agent for integration tests'
service PiAgentService {
  @readonly
  entity Books as projection on my.Books { ID, title, author.name as author };
}
