// The client re-sends the full board (cards + table rows) with every message,
// so the request body can exceed CAP's default 100 KB — especially in live mode
// where Nomí keeps growing the board. Raise the body-parser limit for this service.
@agent @odata
@cds.server.body_parser.limit: '5mb'
service nomi {

    // ── Start a new Nomí session, returns a handle to identify it ───
    action startSession() returns SessionHandle;

    // ── Send user input; response is a JSON-lines stream ────────────
    //
    // `cards` is the JSON array of cards currently on screen — the server keeps
    // no card state between turns, so the client sends it with every message.
    //
    // Stream event shapes (the client derives highlights/expressions itself):
    //   { "type": "reasoning",  "text": "…" }
    //   { "type": "token",      "text": "…" }
    //   { "type": "data-point", "id": "…", "label": "…",
    //                           "dtype": "metric"|"text"|"progress"|"markdown"|"table",
    //                           "value": "…" | "rows": [ … ],
    //                           "unit": "…", "trend": "up"|"down"|"neutral",
    //                           "detail": "…", "span": "1"|"2"|"3"|"row" }
    //   { "type": "remove",     "id": "card-id" }
    //   { "type": "error",      "message": "…" }
    //   { "type": "flush" }
    //
    //
    // `auto` marks an autonomous pass in live mode (no user is waiting): the
    // server supplies the refine directive and the client stays silent.
    action sendMessage(sessionId: UUID, message: String, cards: LargeString, auto: Boolean)
        returns @Core.MediaType LargeBinary;

    // ── Tool: text-to-speech (not exposed to LLM) ───────────────────
    action speak(text: String not null) returns @Core.MediaType LargeBinary;

    // ── LLM-callable tools ───────────────────────────────────────────

    @description: 'Update your persistent notes for this conversation. Call after each meaningful exchange. Notes completely replace the previous version — include everything needed to continue the conversation from scratch. Structure: what has been discussed, what data was shown (with card IDs), what was done, what is pending.'
    action update_notes(content: LargeString not null) returns String;

    @description: 'Remove a card ONLY when its content is completely stale and will never be referenced again in this conversation. Do NOT remove cards when shifting topics — update them in place instead. Never remove the only card on screen.'
    action remove_card(id: String not null) returns String;

    @description: 'Render a data card in the UI panel. Use for a single metric, short fact, progress bar, or hand-crafted markdown. For cards backed by live query data use action with a nested query call instead. dtype: metric | text | progress | markdown (default). span: "1" compact | "2" medium | "3" wide | "row" full-width (required for markdown). Reuse the same id to update in place.'
    action show_data(
        id     : String not null,
        label  : String not null,
        value  : String not null,
        dtype  : String,
        unit   : String,
        trend  : String,
        detail : String,
        span   : String
    ) returns String;

    @description: 'Describe a CDS service, entity, or action. Use to inspect field names and types before querying. Examples: describe(service:"CatalogService") — lists all entities and actions. describe(service:"CatalogService", entity:"Books") — shows fields of Books.'
    action describe(service: String, action: String, entity: String) returns String;

    @description: 'Query live data using CDS Query Language (CQL). Returns a JSON array string. For displaying results use action with a nested query call instead of putting raw data in show_data. Example: "SELECT date, airline, origin, destination FROM sap.capire.flights.data.Flights LIMIT 20".'
    action query(cql: String not null) returns String;

    @description: 'Render a card whose value is a JSON array (typically a nested query result) or a CQL SELECT — its rows are sent to the UI to render as a table. For a single value use show_data instead. To display live data, pass a nested query call as the value via the action tool.'
    action create_card(
        id    : String not null,
        label : String not null,
        value : LargeString not null,
        span  : String
    ) returns String;

    @description: 'Call any service action. Any argument value that is itself an action call — {action:"name", args:{...}} or {service:"svc", action:"name", args:{...}} — is resolved first, with independent siblings running in parallel. Use this to chain tools: pass query results directly as arguments without loading data into your context. Example: {action:"create_card", args:{id:"flights", label:"Flights", value:{action:"query", args:{cql:"SELECT date, airline FROM sap.capire.flights.data.Flights LIMIT 30"}}}}'
    action action(service: String, action: String not null, args: Map) returns String;
};

type SessionHandle {
    ID: UUID;
}
