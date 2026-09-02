using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Standard agent flow for pseudonymization OTel-leak e2e testing.
 * Exposes Authors (with @PersonalData annotations) so the query tool result
 * carries personal data that the pseudonymize middleware must scrub from traces.
 */
@agent
@description: 'Book agent exposing author personal data for pseudonymization tests'
@Core.SchemaVersion: '3'
service PseudoBookService {
  @readonly
  entity Authors as
    projection on my.Authors
    excluding {
      books
    };
}
