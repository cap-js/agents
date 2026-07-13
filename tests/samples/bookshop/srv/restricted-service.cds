using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Restricted agent service — requires 'admin' role.
 * Used by access-control tests to verify @requires enforcement on A2A endpoint.
 */
@agent
@(requires: 'admin')
@description: 'Restricted agent (admin only)'
service RestrictedAgentService {
  @readonly entity Books as projection on my.Books { ID, title, createdBy };
}
