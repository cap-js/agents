using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Custom agent card service demonstrating agentCardPath override.
 * The card is loaded from an explicit markdown file instead of being auto-generated from CDS.
 */
@a2a
service CustomAgentCardService {
  @readonly entity Books as projection on my.Books;
}
