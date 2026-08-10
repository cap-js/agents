namespace travel.local;

/**
 * A curated destination guide entry — a local-only reference dataset served
 * over MCP to the in-process travel agent.
 */
entity Destinations {
  key code        : String(3);   // e.g. FRA, JFK
      city        : String(111);
      country     : String(111);
      description : String(1111);
      bestSeason  : String(111);
}
