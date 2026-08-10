using {sap.capire.bookshop as my} from '../db/schema';

/**
 * Streaming metrics/audit integration test service.
 * Uses InstrumentedOrchestrationClient with streaming: true
 * pointed at mock AI Core.
 */
@agent
@description: 'Streaming metrics test agent'
service StreamingMetricsService {
  @readonly
  entity Books as projection on my.Books { ID, title, stock };
}
