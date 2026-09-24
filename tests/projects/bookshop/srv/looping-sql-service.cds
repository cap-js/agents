using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Looping agent that emits SQL-format query tool calls.
 * Used to test status-update middleware label resolution in SQL format mode.
 */
@agent
@description: 'Looping agent for SQL format status-update testing'
service LoopingSqlService {
  @readonly
  entity Books as projection on my.Books { *, author.name as author }
    excluding { createdBy, modifiedBy };
}
