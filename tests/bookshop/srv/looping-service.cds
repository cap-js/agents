using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Looping graph service for quota enforcement e2e testing.
 * The graph loops multiple times (agent → tools → agent) to trigger per-node quota limits.
 */
@a2a
@description: 'Looping agent for quota testing'
service LoopingService {
  @readonly
  entity Books as projection on my.Books { *, author.name as author }
    excluding { createdBy, modifiedBy };
}
