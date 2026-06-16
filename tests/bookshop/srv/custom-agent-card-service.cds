using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Custom agent card service demonstrating the `@a2a.card` annotation.
 * The card is loaded from an explicit markdown file instead of being
 * auto-generated from CDS.
 */
@a2a
@a2a.card: 'custom-agent-card.md'
service CustomAgentCardService {
  @readonly entity Books as projection on my.Books;
}
