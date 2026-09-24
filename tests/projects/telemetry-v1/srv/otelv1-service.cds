using { test.otelv1 as my } from '../db/schema';

/**
 * OTEL v1 backward-compat test service
 */
@agent
@description: 'OTEL v1 telemetry backward-compat test'
service OtelV1Service {
  @readonly
  entity Books as projection on my.Books;
}
