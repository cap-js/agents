using { sample.products } from '../db/schema';

/**
 * Zero-code deep agent — pure convention.
 *
 * No `.js` handler exists for this service. The plugin:
 *   - matches the slugified service name `zero-code-agent` against the sibling
 *     directory `./zero-code-agent/`;
 *   - sees `AGENTS.md` inside it and auto-builds a `deepagent` runtime with
 *     CDS-derived tools (query, describe), filesystem-backed skills/memory,
 *     and content-filter recovery middleware.
 */
@a2a
service ZeroCodeAgentService {
  @readonly entity Products as projection on products.Products;
}
