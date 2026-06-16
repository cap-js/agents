using { test.debug as my } from '../db/schema';

/**
 * Debug tracing test service — has both a working graph and a failing graph
 */
@agent
@description: 'Debug tracing test'
service DebugService {
  @readonly
  entity Books as projection on my.Books;
}
