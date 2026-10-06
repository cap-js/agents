using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Agent enabled purely via the generic `@protocol` annotation (no `@agent`).
 * Regression coverage for services declared as
 * `@(protocol: ['odata-v4','mcp','agent'])`.
 */
@(protocol: ['odata-v4', 'mcp', 'agent'])
@description: 'Agent enabled through @protocol instead of @agent'
service ProtocolAgentService {
  @readonly
  entity Books as projection on my.Books {
    key ID,
    title
  };
}
