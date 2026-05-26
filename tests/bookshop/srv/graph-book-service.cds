using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Graph-based agent for telemetry e2e testing
 */
@a2a
@description: 'Graph-based book agent with LLM metrics'
service GraphBookService {
  @readonly
  entity Books as projection on my.Books { *, author.name as author }
    excluding { createdBy, modifiedBy };
}
