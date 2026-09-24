using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Custom agent card service demonstrating the `@agent.card` annotation.
 * The card is loaded from an explicit markdown file instead of being
 * auto-generated from CDS.
 */
@agent
@agent.card: 'custom-agent-card.md'
service CustomAgentCardService {
  @readonly entity Books as projection on my.Books;
}
