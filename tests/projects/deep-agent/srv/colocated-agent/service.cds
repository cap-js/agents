using { sample.products } from '../../db/schema';

/**
 * Co-located deep agent — AGENTS.md sits next to the service.cds file
 * inside the same folder, rather than in a dedicated sub-directory.
 *
 * This exercises the step-2 resolution path in resolveAgentDir():
 *   the plugin checks whether AGENTS.md exists directly in srcDir
 *   (the folder that contains the .cds source file) before falling
 *   through to the slug-based sibling / agents/ lookups.
 */
@agent
service ColocatedAgentService {
  @readonly entity Products as projection on products.Products;
}
