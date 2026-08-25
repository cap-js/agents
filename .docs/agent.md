# @cap-js/agents APIs

## LLM

```js

// The LLMService is there for cds.requires.llm configuration and can be extended with each LLM provider
export class LLMService extends ApplicationService {
  async init() {
    this.on('*', this.onPrompt)
  }

  async onPrompt(req) {
    const { query, iterator } = req
    // Have a simple srv.send("prompt") API that just works
    if(typeof query === 'string') query = [{ kind: 'user', message: query }]
    const result = iterator ? this._library.stream(query) : this._library.send(query)
    return result
  }
}
```

## AgentService

TODO: file based agents
TODO: agent cards

```js

// The AgentService is primarly there for `cds.connect.to('agents')` and cds.requires.agents
export class AgentService extends ApplicationService {
  async init() {
    this.on('start', this.onStart)
  }

  async start(req) {
    return new AgentSession(this, { context: req.data.context})
  }
}

// The AgentSession class can be extended for special harness behaviors
export class AgentSession extends stream.Duplex {
  constructor(srv, options) {
    this.srv = srv
    this.options = options
    this.ID = options?.ID ?? cds.utils.uuid()
    super({objectMode:true})
  }

  // stops the agent session from progressing
  pause() {}; resume() {}
  cork()  {}; uncork() {}

  read(size) {
    // return new messages from the session
  }

  async write(message, encoding, callback) {
    // send a message to the end of the session
    const llmOptions = this.options.llm
    const llm = await cds.connect.to(
      llmOptions?.service || llmOptions, 
      typeof llmOptions === 'object' ? llmOptions : undefined
    )

    const { Messages } = this.srv.entities()
    await cds.ql.INSERT(this.normalizeMessage(message)).into(Messages)
    const context = await this.loadSession()
    const results = await llm.send(context)
    for await(const result of results) {
      const response = this.normalizeMessage(result)
      await cds.ql.INSERT(response).into(Messages)
      this.push(response) // reply
    }

    if (typeof callback === 'function') callback()
  }

  normalizeMessage(message) {
    return message
  }

  async *loadSession() {
    const { Sessions } = this.srv.entities()

    const sessionQuery = cds.ql`SELECT role, type, message, query FROM ${Sessions}[ID=${this.ID}]:messages ORDER BY createdAt asc`
    for await(const {role, type, message, query} of sessionQuery) {
      // Allows messages to contain queries rather then results to prevent duplicated data
      // Ensure that queries contain `order by` and `where` clauses that ensure stable results for LLM cache hits
      if(query) yield {role, type, query: await cds.ql(query)}
      else yield {role, type, message}
    }
  }
}
```

```cds

entity Messages : cuid, managed {
      session : UUID;    // The session or branch ID
      sequence: Integer; // n-th message in the session
      prev    : Association to Messages; // parent session for branches
      role    : RoleType;
      type    : MessageType;
      content : LargeString;
      query   : Map;     // CQN query for tool calls / queries
}

// Fake Sessions entity extracted from Messages history
view Sessions as projection on Messages {
  key session as ID,
      min(createdAt) as createdAt,
      max(modifiedAt) as modifiedAt,
      // optional computed columns
      // sum(tokens) as tokens,
      // max(sequence) as messages,
} mixin { // This is psuedo cds ...
  messages: Association of many to Messages on messages.session = ID
}
group by session;

type RoleType: String enum { user; assistant; system; tool; };

type MessageType : String enum {
  text;           // plain text — all providers
  image;          // vision input — all providers
  file;           // document / file reference — Anthropic, Vercel AI, A2A
  tool_call;      // always stored as query — all providers
  tool_result;    // stored as query (lazy) or content (resolved) — all providers
  reasoning;      // thinking block — Anthropic, OpenAI o1/o3, Vercel AI (optional)
  data;           // structured JSON payload — A2A DataPart, structured output
};
```

## A2A protocol adapter

```js
export class A2AAdapter extends HttpAdapter {
  get router() {
    const router = super.router
    // router.use() / router.get / router.post ...
    // With all express middleware implementations being direct proxies to the AgentService
    return router
  }
}
```
