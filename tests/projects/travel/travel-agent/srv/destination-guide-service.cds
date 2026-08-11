using {travel.local as my} from '../db/schema';

/**
 * Local-only destination guide served over the MCP protocol.
 *
 * This service lives in the SAME CDS model as TravelAgentService (an @agent
 * service) and has NO cds.requires credentials. TravelAgentService therefore
 * discovers it via availableMcp auto-discovery and wires its tools through
 * buildMcpToolsLocally — driven in-process, with no HTTP round-trip (the
 * mirror image of the local sub-agent path). Contrast with FlightsService,
 * which is reached remotely over HTTP via cds.requires.
 */
@mcp
@description: 'Local destination guide with city descriptions and travel tips'
service DestinationGuideService {

  /** Browse curated destination guide entries */
  @readonly
  entity Destinations as projection on my.Destinations;
}
