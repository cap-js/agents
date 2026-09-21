import cds from '@sap/cds'
import { AgentService, AgentSession } from '@cap-js/agents'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { synthesizeSpeech } from './tts.js'
import { lintCql } from './cql-guard.js'

// ── NomiService ───────────────────────────────────────────────────────
// A thin conductor over @cap-js/agents. It exposes Nomí's tools, resolves
// nested action calls, and turns the session's chunk stream into the
// JSON-lines the browser consumes. Nothing about the conversation is persisted:
// the current turn lives in memory (NomiSession) and Nomí's notes are the only
// state that carries across turns. All presentation lives in the client — the
// server never formats tables, scans for highlights, or holds card state
// between turns; the browser sends its current cards with each message.
export default class NomiService extends AgentService {
  AgentSession = NomiSession

  async init() {
    // Session lifecycle + streaming entry point
    this.on('startSession', () => ({ ID: cds.utils.uuid() }))
    this.on('sendMessage', this.onSendMessage)
    this.on('speak', this.onSpeak)

    // Card tools — each returns a small envelope ({ _card } / { _remove }).
    // toClientEvents turns it into a UI event; loadSession folds it into the
    // board and replays it to the LLM as a short ack (never the raw JSON).
    this.on('show_data', req => {
      const { id, label, value, dtype, unit, trend, detail, span } = req.data ?? {}
      return JSON.stringify({ _card: { id, label, value, dtype, unit, trend, detail, span } })
    })
    this.on('remove_card', req => JSON.stringify({ _remove: req.data?.id }))
    this.on('create_card', async req => {
      let { id, label, value, span = 'row' } = req.data ?? {}
      // A nested { action:'query', … } value means "run this, then show the
      // result". Resolve it here so create_card works whether it was called
      // directly OR wrapped in the action tool — the LLM can't get this wrong.
      ;({ value } = await resolveArgs({ value }, this._dispatch.bind(this)))
      // A JSON-array value (typically a nested query result) or a CQL SELECT
      // becomes a table; anything else is treated as hand-written markdown.
      const rows = await rowsFromValue(value)
      return JSON.stringify(rows
        ? { _card: { id, label, dtype: 'table', rows, span } }
        : { _card: { id, label, dtype: 'markdown', value, span } })
    })

    // Notes live in the session's persistence, not in server memory.
    this.on('update_notes', async req => {
      const content = req.data?.content
      if (req.session && content != null) await req.session.saveNotes(content)
      return JSON.stringify({ ok: true })
    })

    return super.init()
  }

  async onSpeak(req) {
    const wav = await synthesizeSpeech(req.data?.text)
    if (!wav) return
    req.res?.set?.('Content-Type', 'audio/wav')
    req.reply(Readable.from([wav]))
  }

  // Call any service action. An argument shaped { action, service?, args? } is
  // itself a call — resolved first so query results flow straight onto a card
  // without ever entering the LLM's context. Siblings resolve in parallel.
  async onAction(req) {
    let { service, action, args } = req.data
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch {} }

    // A call with no action name ran nothing. The model almost always meant to
    // make a card but nested the card's own params under `args` and dropped the
    // action name — so fail loudly with the exact shape instead of dispatching
    // an undefined event (which silently returns nothing / hangs) and leaving an
    // empty board the critic can only call "unfinished".
    if (!action || typeof action !== 'string') {
      cds.error`the "action" tool ran nothing because no action name was given. To put data on a card, call create_card directly — create_card(id:"…", label:"…", value:{action:"query", args:{cql:"SELECT …"}}) — or name it: action(action:"create_card", args:{…}).`
    }

    const dispatch = this._dispatch.bind(this)
    return dispatch(service, action, await resolveArgs(args, dispatch))
  }

  // Dispatch one action call, returning its result as a string. Nomí's own
  // actions always run locally, whatever service the LLM named.
  async _dispatch(svc, act, a) {
    if (!act) cds.error`no action name — nothing to dispatch` // never send an undefined event
    const target = this.actions[act] ? this.name : (svc || this.name)
    const res = await (await cds.connect.to(target)).send(act, a)
    return typeof res === 'string' ? res : JSON.stringify(res ?? null)
  }

  // The `query` action — reached whenever a SELECT is dispatched through the
  // service, i.e. the nested action→query that fills every card (onAction →
  // resolveArgs → send('query')). This is Nomí's display path, so guarding it
  // here covers every SELECT that actually renders data. (The bare `query`
  // *tool* is a raw read the framework runs directly for in-context reasoning;
  // create_card's own CQL strings are linted in rowsFromValue.) lintCql throws a
  // corrective message on a schema violation (e.g. ranking money across
  // currencies); the framework relays that to the model as a tool error and it
  // self-corrects on the next round.
  async onQuery(req) {
    lintCql(req.data?.cql)
    return super.onQuery(req)
  }

  async onSendMessage(req) {
    let { sessionId, message, cards, auto } = req.data
    // An autonomous pass (live mode) carries no user text — the server supplies
    // the refine directive that drives Nomí through its self-refinement modes.
    if (auto) message = LIVE_DIRECTIVE
    if (!sessionId) cds.error`sessionId is required`
    if (!message?.trim()) cds.error`message is required`

    // Load AGENT.md personality; expose the whitelisted actions as LLM tools.
    // Nomí no longer curates its own memory — the harness does that after the
    // turn (see curateNotes). So `update_notes` is offered only to the
    // autonomous pass, whose self-refinement modes still author their own state.
    const { agent } = await this.deep(this)
    const LLM_TOOLS = ['show_data', 'remove_card', 'create_card', 'query', 'action']
    if (auto) LLM_TOOLS.push('update_notes')
    const tools = Object.fromEntries(
      LLM_TOOLS.filter(name => this.actions[name]).map(name => [name, this.actions[name]])
    )

    // The browser sends the cards currently on screen — the server keeps no
    // card state between turns.
    const session = new NomiSession(this, { tools, agent, ID: sessionId, cards })
    session._request = message   // what the completion gate checks against
    session._auto = !!auto

    const managed = await this.pipeline(session)
    managed.write(message)

    pipeline(
      managed,
      source => completionGate(session, source),
      source => toClientEvents(source),
      async function* (source) { req.reply(Readable.from(source)) },
    ).catch(() => {})
  }
}

// ── NomiSession ───────────────────────────────────────────────────────
// This is the whole point of the demo: a rolling-window context instead of a
// classic ever-growing linear history. We deliberately DO NOT persist the
// conversation. The current turn — the user's message, Nomí's replies, its
// tool calls and their results — lives only in an in-memory buffer for the
// duration of the turn and is discarded when it ends. The one thing that
// survives across turns is Nomí's own notes (saveNotes): a curated rolling
// summary that carries far more signal per token than replaying every message.
class NomiSession extends AgentSession {
  _turn = []   // the current turn's messages, in order — never persisted

  // The base pipeline writes here to record the turn (user input, assistant
  // text, tool calls, tool results). We keep it all in memory. store() streams
  // assistant text as a PassThrough, so drain it to a string first.
  async _write(message, _enc, callback) {
    try {
      if (typeof message === 'string') message = { role: 'user', type: 'text', content: message }
      if (message?.content && typeof message.content.read === 'function') {
        const chunks = []
        for await (const chunk of message.content) chunks.push(String(chunk))
        message = { ...message, content: chunks.join('') }
      }
      this._turn.push(message)
      // A user message or a tool result unblocks the next LLM round (base _read).
      if (message.role === 'user' || message.type === 'tool_result') this._waiting.resolve()
      callback?.()
    } catch (err) {
      callback?.(err)
    }
  }

  async *loadSession() {
    const { tools, system, agent, cards } = this.options
    if (tools && Object.keys(tools).length) yield { role: 'system', type: 'tools', content: tools }
    if (system) yield { role: 'system', type: 'text', content: system }
    if (agent?.content) yield { role: 'system', type: 'text', content: agent.content }
    yield { role: 'system', type: 'text', content: `Session: ${this.ID}` }

    // A live overview of every service Nomí can query or call, one block per
    // service, rebuilt from the runtime registry each turn.
    const SKIP = new Set(['nomi', 'db', 'messaging', 'agents'])
    yield {
      role: 'system', type: 'text',
      content: 'Available services — use query("SELECT ... FROM ServiceName.EntityName") to read data and the action tool to call service actions:',
    }
    for (const [svcName, svc] of Object.entries(cds.services ?? {})) {
      if (SKIP.has(svcName)) continue
      const block = describeService(svcName, svc)
      if (block) yield { role: 'system', type: 'text', content: block }
    }

    const notes = await this.loadNotes()
    if (notes) yield { role: 'system', type: 'text', content: `## Your notes\n${notes}` }

    // Cards the client had on screen when the user sent this message.
    const board = clientCards(cards)
    if (board.size) yield { role: 'system', type: 'text', content: cardsMessage('Cards on screen', board) }

    // The current turn is entirely in memory: the user message plus whatever
    // Nomí has produced so far across this turn's tool rounds. Fold card results
    // into a live board view and collapse their bulky JSON into short acks (the
    // UI already received the card via the stream) so context stays lean.
    const live = new Map(board)
    const replay = []
    let spoke = false
    let lastCardRow = null
    for (const row of this._turn) {
      if (row.role === 'system') continue
      if (row.role === 'assistant' && row.type === 'text' && row.content?.trim()) spoke = true

      const env = cardEnv(row)
      if (env) {
        if (env._card?.id) live.set(env._card.id, { ...live.get(env._card.id), ...prune(env._card) })
        if (env._remove) live.delete(env._remove)
        const acked = { ...row, content: ackFor(env) }
        replay.push(acked)
        lastCardRow = acked
      } else {
        replay.push(row)
      }
    }

    // If cards changed this turn, show the resulting board before the messages.
    if (replay.some(r => r.type === 'tool_result') && cardsMessage('', live) !== cardsMessage('', board))
      yield { role: 'system', type: 'text', content: cardsMessage('Cards after your updates this turn', live) }

    // Steer the follow-up by appending guidance to the LAST card result — a
    // trailing system message would be ignored once messages have started. Only
    // when the last thing that happened was a card mutation (by envelope, so an
    // `action`-wrapped card still steers).
    const last = replay[replay.length - 1]
    const steerable = last && last === lastCardRow
    for (const row of replay) {
      if (row === last && steerable) {
        yield { ...row, content: `${row.content}\n\n${spoke ? TURN_END_SPOKEN : TURN_END_SILENT}` }
      } else {
        yield row
      }
    }
  }

  // Notes replace history — the only state persisted across turns, as a single
  // system/data row per session.
  async saveNotes(content) {
    const { Messages } = cds.model.entities('cap.agent')
    await DELETE.from(Messages).where({ session: this.ID, role: 'system', type: 'data' })
    await INSERT.into(Messages).entries({ session: this.ID, sequence: 0, role: 'system', type: 'data', content })
  }

  async loadNotes() {
    const { Messages } = cds.model.entities('cap.agent')
    const row = await SELECT.one.from(Messages).columns('content').where({ session: this.ID, role: 'system', type: 'data' })
    return row?.content
  }
}

// ── Session-output → JSON-lines for the browser ───────────────────────
// A flat translation: reasoning/speech stream through raw (the client decides
// what to highlight); card results become data-point / remove events. Nothing
// is buffered or scanned here.
async function* toClientEvents(source) {
  const log = cds.log('nomi')
  try {
    for await (const chunk of source) {
      if (chunk.role === 'flush') { logStream.end(); yield jsonl({ type: 'flush' }); break }

      switch (chunk.type) {
        case 'reasoning':
          if (chunk.content) { logStream(log, 'reasoning', chunk.content); yield jsonl({ type: 'reasoning', text: chunk.content }) }
          break
        case 'text':
          if (chunk.role === 'assistant' && chunk.content) { logStream(log, 'speak', chunk.content); yield jsonl({ type: 'token', text: chunk.content }) }
          break
        case 'tool_call':
          logStream.end()
          log.info('→ tool', chunk.query?.tool, chunk.query?.args ?? '')
          break
        case 'tool_result': {
          const env = safeParse(chunk.content)
          logStream.end()
          if (env?._card?.id) { log.info('← card', env._card.id, `(${env._card.dtype ?? 'markdown'})`); yield jsonl({ type: 'data-point', ...env._card }) }
          else if (env?._remove) { log.info('← remove', env._remove); yield jsonl({ type: 'remove', id: env._remove }) }
          else if (env?.error) log.warn('← tool error:', chunk.query?.tool, env.error)
          else log.info('← tool result', chunk.query?.tool)
          break
        }
        case 'error':
          logStream.end()
          log.error('error:', chunk.content)
          yield jsonl({ type: 'error', message: chunk.content })
          break
      }
    }
  } catch (err) {
    logStream.end()
    log.error('stream failed:', err.message)
    yield jsonl({ type: 'error', message: err.message })
    yield jsonl({ type: 'flush' })
  }
}

// ── Completion gate + memory curation ─────────────────────────────────
// A turn reaches the client as a `flush` only once the model stops calling
// tools. This stage intercepts that moment: a cheap llm-service critic checks
// whether the board actually satisfies the request, and if not, feeds a one-line
// fix back and lets the turn continue — so the harness, not the prompt, decides
// when the goal is met. When the turn does end, it hands memory curation to the
// harness (off the critical path) instead of relying on the model to keep notes.
const CONTINUE_PREFIX = 'Not finished yet. '
const MAX_CONTINUATIONS = 4   // safety valve against a non-converging critic

async function* completionGate(session, source) {
  const board = clientCards(session.options.cards)   // what was on screen at turn start
  let continuations = 0
  let spoken = []       // assistant speech buffered for the latest speaking round
  let newRound = false  // a tool_result has passed, so the next speech is a new round

  for await (const chunk of source) {
    if (chunk.type === 'tool_result') {
      // Track the live board off the result envelope (see cardEnv), not the tool
      // name — so `action`-wrapped cards count and the critic sees the real board.
      const env = cardEnv(chunk)
      if (env?._card?.id) board.set(env._card.id, { ...board.get(env._card.id), ...prune(env._card) })
      if (env?._remove) board.delete(env._remove)
      newRound = true   // whatever the model says next belongs to a fresh round
      yield chunk
      continue
    }

    // Hold back spoken words so only the FINAL round's pointer reaches the user:
    // guard-correction and continuation rounds each make the model talk, and the
    // eval/UI would otherwise hear every attempt. Keep just the latest round's speech.
    if (chunk.type === 'text' && chunk.role === 'assistant') {
      if (newRound) { spoken = []; newRound = false }
      spoken.push(chunk)
      continue
    }
    if (chunk.role !== 'flush') { yield chunk; continue }

    // Terminal flush: the model wants to end. Gate it (interactive turns only).
    if (!session._auto && continuations < MAX_CONTINUATIONS) {
      const verdict = await checkComplete(session._request, board)
      if (verdict?.satisfied === false) {
        continuations++
        spoken = []; newRound = false   // this attempt wasn't the final answer
        const fix = verdict.fix?.trim() || 'Call create_card with value:{action:"query", args:{cql:"SELECT … ORDER BY … LIMIT …"}} so the answer\'s rows land on a card.'
        session.write({ role: 'user', type: 'text', content: CONTINUE_PREFIX + fix })
        continue   // swallow the flush; the injected nudge drives another round
      }
    }
    for (const t of spoken) yield t   // release the final pointer, after its card
    spoken = []
    if (!session._auto) curateNotes(session).catch(() => {})   // off critical path
    yield chunk
  }
}

// One cheap llm-service call: is the request satisfied by what is on the board?
// Sees only the compact board digest (never the raw rows) to stay cheap and to
// avoid confusing a small model with bulky data. The prompt spells out that a
// card summarised as "N rows [columns]" IS holding real data — otherwise the
// critic reads a row count as "no data" and loops, re-creating a card already on
// screen. Fails open — a judge or parse error never blocks the turn from ending.
async function checkComplete(request, board) {
  try {
    const llm = await cds.connect.to('llm')
    const digest = board.size ? cardsMessage('', board) : '(the board is empty — no cards)'
    const res = await llm.send(`You verify whether a data assistant has FINISHED the user's request, and if not, tell it exactly what to do next.
USER REQUEST: ${request}
CARDS NOW ON SCREEN:
${digest}

Each card line summarises its contents: "N rows [columns]" means the card is already DISPLAYING N rows of real data with those columns — that is proof the data is on screen. You are not shown the individual cell values and must NOT ask to see them.
The request is SATISFIED when a card already holds the answer: for a show / list / rank / "dashboard" request, a table card with at least one row and sensible columns IS the answer, even if terse. It is NOT satisfied only when the board is empty, the answer is merely promised, or the only card is a single count/label with no rows. Never ask for a card that already exists.
If it is NOT satisfied, "fix" must be ONE concrete next step that names the tool to call and what to put on the card — never just "not finished". Prefer the display path, e.g.: create_card(id:"…", label:"…", value:{action:"query", args:{cql:"SELECT … ORDER BY … LIMIT …"}}). If the board is empty, the previous attempt made no card — tell it to call create_card with that nested-query value now.
Reply with ONLY compact JSON, no prose: {"satisfied": true|false, "fix": "<the concrete next step, empty if satisfied>"}`)
    return JSON.parse(textOf(res).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  } catch { return null }
}

// After the turn, fold the turn into the rolling note. The harness owns memory
// so a small model never has to decide what to remember or how to format it.
async function curateNotes(session) {
  const turn = (session._turn ?? []).filter(m => m.role !== 'system' && typeof m.content === 'string')
  if (!turn.length) return
  try {
    const llm = await cds.connect.to('llm')
    const prior = (await session.loadNotes()) || '(none)'
    const transcript = turn.map(m => `${m.role}/${m.type}: ${m.content.slice(0, 400)}`).join('\n')
    const res = await llm.send(`Maintain a compact rolling memory note for a data assistant by merging the PRIOR NOTE with what happened THIS TURN. Keep only durable conversation context, past tense, under ~120 words, as two short sections:
Discussed: <topics and answers already given>
Pending: <open follow-ups, or "none">
Do not list card contents or raw data rows. Reply with ONLY the note text.

PRIOR NOTE:
${prior}

THIS TURN:
${transcript}`)
    const note = textOf(res).trim()
    if (note) await session.saveNotes(note)
  } catch { /* memory is best-effort; never fail a turn over it */ }
}

const textOf = res => (Array.isArray(res) ? res : []).reduce((s, c) => s + (c?.type === 'text' ? c.content : ''), '')

// ── Internals ─────────────────────────────────────────────────────────

// Stream reasoning/speech deltas onto a single live console line so the demo
// can watch Nomí think and talk in real time. The first delta of a channel
// opens a labelled line; subsequent deltas append; logStream.end() closes it
// before any other log write (tool calls, results, flush) so lines stay clean.
const logStream = (() => {
  let open = null
  const fn = (log, channel, text) => {
    if (!log._debug) return                       // only when nomi debug logging is on
    if (open !== channel) { fn.end(); process.stdout.write(`[nomi] ${channel.padEnd(9)} `); open = channel }
    process.stdout.write(text)
  }
  fn.end = () => { if (open) { process.stdout.write('\n'); open = null } }
  return fn
})()

const TURN_END_SPOKEN = 'You have already spoken and your card tool has run. If the request is fully handled, END your turn now — reply with no tool calls and no narration (or just "done"). Do not repeat yourself.'
const TURN_END_SILENT = 'Your card is now on screen. Say one short pointer sentence out loud, then end your turn.'

// Live mode: the client fires an autonomous pass whenever Nomí is idle. No user
// is waiting, so Nomí works silently and makes ONE focused improvement, then
// ends — the loop calls again. A confidence score and the current mode live in
// the notes (the only state that survives a pass), so Nomí cycles through
// evaluate → clean → refine → verify → expand → propose on its own. The board
// itself is the context the LLM sees each turn, so every pass must keep it
// COMPLETE yet BOUNDED — refining and consolidating, never growing endlessly.
const LIVE_DIRECTIVE = `AUTONOMOUS PASS — no user is waiting and you were not addressed. Work SILENTLY: produce NO spoken sentence and no narration. Use your tools only, make ONE focused improvement, then END the turn. You will be called again to continue.

THE BOARD IS YOUR MEMORY. The cards on screen are the entire context you get next pass — there is no hidden history. So the board must stay COMPLETE (everything needed to keep serving the goal is on it) yet BOUNDED (it must never grow indefinitely):
- Prefer improving or MERGING existing cards over adding new ones. Reuse the same id to update in place.
- Store compact aggregates and summaries, NOT raw rows. If a card holds a long table, replace it with the counts/totals/top-N that actually answer the goal.
- Every fact must earn its place. If two cards overlap, consolidate them into one. Board hard limit: 6 cards.

Each pass:
1. Read your notes and the cards on screen. Judge a CONFIDENCE score 0–100: how well does the board reflect the goal — and is it getting bloated or redundant?
2. Pick the ONE mode that fits right now, and do only that:
   • EVALUATE — no clear goal yet, or the board is empty: query the available services and start one useful overview.
   • CONSOLIDATE — the board is bloated, redundant, or holds raw rows: merge overlapping cards and replace verbose data with compact aggregates, keeping every fact the goal needs.
   • CLEAN — stale or off-topic cards: remove them.
   • REFINE — a card is vague or raw: improve it (better aggregate, clearer breakdown, right dtype/span).
   • VERIFY — a number may be out of date: re-query and update it in place.
   • EXPAND — confidence is moderate AND the board has room: add the single most useful missing view.
   • PROPOSE — confidence is high AND the board has room: surface ONE new, genuinely interesting angle grounded in your notes.
   Low confidence → consolidate / clean / refine / verify what is there. High confidence → expand / propose, but only if the board has room.
3. Call update_notes LAST, recording: confidence (0–100), the mode you ran, what changed, and the next thing to look at. This is the only memory that survives to the next pass.

Never invent data — query it. Never speak. Then end the turn.`

const jsonl = obj => JSON.stringify(obj) + '\n'
const safeParse = s => { try { return JSON.parse(s) } catch { return null } }
const prune = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null))
const ackFor = env => env._remove ? JSON.stringify({ ok: true, removed: env._remove }) : JSON.stringify({ ok: true, card: env._card?.id })

// A tool_result carries a card mutation when its envelope holds _card/_remove —
// whether it came straight from create_card/show_data/remove_card or from the
// `action` tool wrapping one (Nomí's mandated display path). Detect it by the
// envelope, exactly as toClientEvents does for the UI, so the board the critic
// sees, the context the model sees, and the screen never disagree. Keying off
// the tool name misses every `action`-wrapped card — which loops the completion
// gate forever, re-creating a card that is already on screen.
const cardEnv = row => {
  if (row?.type !== 'tool_result') return null
  const env = safeParse(row.content)
  return env && (env._card || env._remove) ? env : null
}

// A create_card value is a table when it is a JSON array or a CQL SELECT we can
// run; anything else is markdown. CQL only — never a CQN object (the DB rejects
// unions on its own).
async function rowsFromValue(value) {
  if (Array.isArray(value)) return value
  // A non-string object here is not a runnable query — a resolvable nested
  // { action, … } value was already run before we got here (see create_card),
  // so anything left is malformed. Fail loudly rather than render [object Object].
  if (value && typeof value === 'object') cds.error`create_card value must be a CQL SELECT string or a nested query, e.g. value:{action:"query", args:{cql:"SELECT …"}}.`
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.startsWith('[')) { const p = safeParse(s); return Array.isArray(p) ? p : null }
  if (s.startsWith('{')) cds.error`create_card value must be a CQL SELECT string, a JSON array, or a nested query value:{action:"query", args:{cql:"SELECT …"}}.`
  if (/^(SELECT|WITH)\b/i.test(s)) { lintCql(s); return cds.run(cds.parse.cql(s)) }
  return null
}

// Recursively resolve action-call arguments: any { action, service?, args? }
// value is executed first, its result passed up as the argument. Siblings run
// in parallel; each level resolves before its parent runs.
async function resolveArgs(args, dispatch) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const entries = await Promise.all(Object.entries(args).map(async ([key, val]) => {
    const call = asCall(val)
    if (!call) return [key, val]
    const result = await dispatch(call.service, call.action, await resolveArgs(call.args ?? {}, dispatch))
    return [key, typeof result === 'string' ? result : JSON.stringify(result ?? null)]
  }))
  return Object.fromEntries(entries)
}

// An action call is an object with a string `action`, or a JSON string of one
// (LLMs serialise nested objects when the parent param is typed String).
function asCall(val) {
  if (val && typeof val === 'object' && !Array.isArray(val) && typeof val.action === 'string') return val
  if (typeof val !== 'string' || !val.trim().startsWith('{')) return null
  const parsed = safeParse(val) ?? safeParse(val.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":'))
  return parsed && typeof parsed.action === 'string' ? parsed : null
}

// One text block describing a service's entities and actions, or '' if empty.
function describeService(svcName, svc) {
  const entities = Object.entries(svc.entities ?? {}).filter(([, e]) => !e['@cds.internal'])
  const actions = Object.entries(svc.actions ?? {}).filter(([name]) => !name.startsWith('_'))
  if (!entities.length && !actions.length) return ''

  const entityLines = entities.map(([, e]) => {
    // Service-relative path (e.g. "Bookings.Supplements") so the LLM forms the
    // correct CQL reference, not just the last segment.
    const rel = e.name.startsWith(svcName + '.') ? e.name.slice(svcName.length + 1) : e.name
    const fields = Object.keys(e.elements ?? {})
      .filter(k => !k.startsWith('_') && e.elements[k]?.kind !== 'entity')
      .slice(0, 14)
    return `  entity ${rel}: ${fields.join(', ')}`
  })
  const actionLines = actions.map(([, a]) => {
    const name = a.name?.split('.').pop() ?? a.name
    const params = Object.keys(a.params ?? {}).join(', ')
    return `  action ${name}(${params})${a['@description'] ? ` — ${a['@description']}` : ''}`
  })
  return [svcName, ...entityLines, ...actionLines].join('\n')
}

// Parse the cards the client sent (a JSON string or array) into a Map by id.
function clientCards(cards) {
  const arr = typeof cards === 'string' ? safeParse(cards) : cards
  return new Map((Array.isArray(arr) ? arr : []).filter(c => c?.id).map(c => [c.id, c]))
}

// A compact system message listing what is on the board — aggregate summaries,
// never full table rows.
function cardsMessage(heading, board) {
  const UNITS = { row: 6, 3: 3, 2: 2, 1: 1 }
  const units = [...board.values()].reduce((s, c) => s + (UNITS[c.span ?? '1'] ?? 1), 0)
  const rows = Math.ceil(units / 6)
  const fullness = rows >= 6 ? ' — OVERCROWDED: consolidate or remove cards before adding more'
    : rows >= 4 ? ' — getting full: prefer updating existing cards over adding new ones' : ''
  const lines = [...board.values()].map(c => {
    const detail = c.rows ? `${c.rows.length} row${c.rows.length !== 1 ? 's' : ''} [${Object.keys(c.rows[0] ?? {}).join(', ')}]` : c.value
    let line = `[${c.id}] ${c.label} (span:${c.span ?? '1'}): ${detail}`
    if (c.unit) line += ` ${c.unit}`
    if (c.detail) line += ` — ${c.detail}`
    return line
  })
  const header = heading ? `## ${heading} (${board.size} card${board.size !== 1 ? 's' : ''}, ~${rows} row${rows !== 1 ? 's' : ''}${fullness})\n` : ''
  return header + lines.join('\n')
}
