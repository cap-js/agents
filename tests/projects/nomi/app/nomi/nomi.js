// ── Nomí Client ───────────────────────────────────────────────────────
const API = '/odata/v4/nomi'

// ── Eye expression definitions ───────────────────────────────────────
const EXPR = {
  neutral:   { scleraRY: 9,    scleraCY: 0, irisRY: 6,    pupilRY: 3.2, glowClass: '',              irisOff: [0, 0]     },
  happy:     { scleraRY: 6,    scleraCY: 1, irisRY: 4.5,  pupilRY: 2.8, glowClass: '',              irisOff: [0, 0]     },
  excited:   { scleraRY: 11,   scleraCY: 0, irisRY: 7.2,  pupilRY: 4,   glowClass: 'glow-excited',  irisOff: [0, 0]     },
  thinking:  { scleraRY: 8,    scleraCY: 0, irisRY: 5.5,  pupilRY: 3,   glowClass: 'glow-thinking', irisOff: [-2, -2.5] },
  surprised: { scleraRY: 11.5, scleraCY: 0, irisRY: 7.5,  pupilRY: 4.5, glowClass: 'glow-surprised',irisOff: [0, 0]     },
  sad:       { scleraRY: 7,    scleraCY: 2, irisRY: 5,    pupilRY: 2.8, glowClass: 'glow-thinking', irisOff: [0, 1]     },
  focused:   { scleraRY: 7.5,  scleraCY: 0, irisRY: 5,    pupilRY: 2.8, glowClass: '',              irisOff: [0, 0]     },
  warm:      { scleraRY: 6.5,  scleraCY: 1, irisRY: 4.5,  pupilRY: 2.8, glowClass: 'glow-warm',     irisOff: [0, 0]     },
  nervous:   { scleraRY: 8.5,  scleraCY: 0, irisRY: 5.8,  pupilRY: 3.2, glowClass: '',              irisOff: [0.5, 0]   },
  playful:   { scleraRY: 8,    scleraCY: 0, irisRY: 5.5,  pupilRY: 3,   glowClass: 'glow-excited',  irisOff: [1, -1]    },
}

const ALL_GLOW = ['glow-excited', 'glow-thinking', 'glow-surprised', 'glow-warm']
const THINK_CLOUD_MAX = 2000  // safety cap on the ticker line length (chars); scroll pauses only past this
const THINK_PACE_MS = 380     // reveal reasoning highlights one at a time at ~speaking speed
const LIVE_REFINE_MS = 2500   // pause between autonomous refine passes in live mode

// ── TTS AudioContext queue ────────────────────────────────────────────
// Keeps the audio thread alive with a silent 1-sample loop so that
// Bluetooth headsets never drop back to HFP/idle between sentences.
// All speech buffers are scheduled back-to-back with no gap.
class TTSQueue {
  constructor() {
    this.ctx       = null
    this.nextAt    = 0
    this._pipe     = Promise.resolve()
    this._sources  = []
  }

  // Call on the first user gesture so AudioContext creation is allowed
  prime() {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      const silence = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const loop    = this.ctx.createBufferSource()
      loop.buffer   = silence
      loop.loop     = true
      loop.connect(this.ctx.destination)
      loop.start(0)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }

  // Queue a sentence; onPlayStart fires ≈20 ms before audio begins (synchronized with playback)
  enqueue(text, onPlayStart = null) {
    if (!text.trim()) return
    this._pipe = this._pipe.then(async () => {
      if (!this.ctx) return
      try {
        const res = await fetch(`${API}/speak`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text }),
        })
        if (!res.ok) {
          console.warn('TTS: speak returned', res.status)
          if (onPlayStart) onPlayStart(0)  // fire highlights immediately — no audio but don't drop them
          return
        }
        const decoded = await this.ctx.decodeAudioData(await res.arrayBuffer())
        const src     = this.ctx.createBufferSource()
        src.buffer    = decoded
        src.connect(this.ctx.destination)
        const now  = this.ctx.currentTime
        const at   = Math.max(now + 0.06, this.nextAt)
        src.start(at)
        this.nextAt = at + decoded.duration
        if (onPlayStart) {
          // Fire callback 20 ms before audio starts; pass audio duration so
          // callers can stagger per-word highlights proportionally within the sentence.
          const delay = Math.max(0, (at - this.ctx.currentTime) * 1000 - 20)
          setTimeout(() => onPlayStart(decoded.duration), delay)
        }
        this._sources.push(src)
        src.onended = () => { this._sources = this._sources.filter(s => s !== src) }
      } catch (e) {
        console.warn('TTS:', e)
        if (onPlayStart) onPlayStart(0)  // fire highlights even on decode/playback failure
      }
    })
  }

  // Stop any playing/scheduled speech; keep context + silent loop alive for BT
  cancel() {
    this._pipe  = Promise.resolve()
    this.nextAt = 0
    for (const src of this._sources) try { src.stop() } catch {}
    this._sources = []
  }
}

// ── NomiApp ───────────────────────────────────────────────────────────
class NomiApp {
  constructor() {
    this.sessionId    = null
    this.isBusy       = false
    this.isListening  = false
    this.recognition  = null
    this._recognizing = false   // true while the browser is actively listening
    this._restartTimer = null

    this.ttsQueue     = new TTSQueue()

    this.curExpr      = 'neutral'
    this.baseExpr     = 'neutral'
    this.exprTimer    = null
    this.exprIrisOff  = [0, 0]
    this.lookTargetId = null
    this.lookTargetEl = null   // element-level focus (specific text within a card)
    this._highlightEl = null   // <mark> wrapping the exact highlighted text
    this._focusCardEl    = null  // .data-card with nomi-card-focus (lookAt/glanceAt level)
    this._thinkMarks     = []    // <mark class="nomi-think-highlight"> elements accumulated during reasoning
    this._thinkFocusCards = new Set() // cards that received nomi-card-focus during reasoning (accumulate, don't swap)
    this._thinkingMode   = false // true while in reasoning phase, before first response token
    this._scanMarks      = []    // transient <mark class="nomi-think-scan"> flickers — words mentioned mid-reasoning
    this._recentScans    = new Map() // word → last flicker time, so the same word doesn't strobe
    this._cardWords      = null  // cached Set of significant words currently on cards (lazy, invalidated on board change)
    this._thinkCloudBuf  = ''    // rolling tail of reasoning text shown in the thinking cloud
    this._thinkQueue     = []    // reasoning highlights waiting to be revealed, one at a time
    this._thinkTimer     = null  // paces the queue at ~speaking speed so highlights don't strobe

    // Orb position — driven by lerp every animation frame
    this.orbPos    = null          // {x,y} — null until first placeHome
    this.orbTarget = { x: 0, y: 0 }
    this.orbLerpK  = 0.06          // speed: 0.025 drift · 0.06 home · 0.08 snap

    this.clientCards   = new Map()  // cards currently on screen — sent to the server each turn
    this.selectedCards = new Set()  // card ids the user has clicked to select

    // Rolling buffers for deriving highlights/glances from the raw text stream.
    // The server no longer scans text — it just streams reasoning + tokens.
    this._tokenQuoteBuf = ''  // holds a trailing open quote in speech across chunks
    this._reasonQuoteBuf = '' // same, for reasoning
    this._speechScanBuf  = '' // last ~150 chars of speech, for card-mention glances
    this._reasonScanBuf  = '' // same, for reasoning
    this._lastGlanceId   = null

    this._speechBubbles    = []         // current-turn speech bubble elements
    this._pendingMessage   = null   // messages queued while Nomi is busy
    this._abortController  = null   // AbortController for the active fetch

    // Live mode: when on, Nomí fires an autonomous refine pass whenever it goes
    // idle. Toggled by the user; the loop schedules the next pass in finally.
    this.live      = false
    this._liveTimer = null
    this._autoInFlight = false  // the in-flight turn is an autonomous pass (preemptable)

    this.svgEls = {}
  }

  async init() {
    this.bindDOM()
    this.placeHome()
    this.setupAnimationLoop()
    await this.startSession()
    this.setupSpeech()
    this.setStatus('ready', 'Ready')
  }

  // ── DOM wiring ────────────────────────────────────────────────────
  bindDOM() {
    this.dom = {
      statusDot:    document.getElementById('status-dot'),
      statusText:   document.getElementById('status-text'),
      micBtn:       document.getElementById('mic-btn'),
      liveBtn:      document.getElementById('live-btn'),
      inputText:    document.getElementById('input-text'),
      sendBtn:      document.getElementById('send-btn'),
      dataArea:     document.getElementById('data-area'),
      nomiFloat:    document.getElementById('nomi-float'),
      selBar:       document.getElementById('selection-bar'),
      selCount:     document.getElementById('sel-count'),
      selDelete:    document.getElementById('sel-delete'),
      selClear:     document.getElementById('sel-clear'),
      responseWrap: document.getElementById('response-wrap'),
      promptBubble: document.getElementById('prompt-bubble'),
      speechBubbles:document.getElementById('speech-bubbles'),
      thinkCloud:   document.getElementById('think-cloud'),
      thinkCloudView: document.getElementById('think-cloud-view'),
      thinkCloudText: document.getElementById('think-cloud-text'),
    }

    this.dom.speechBubbles.addEventListener('click', e => {
      const b = e.target.closest('.speech-bubble')
      if (b) b.classList.toggle('selected')
    })

    const svg = document.getElementById('nomi-svg')
    this.svgEl = svg
    ;['sclera-l','sclera-r','iris-l','iris-r','pupil-l','pupil-r'].forEach(id => {
      this.svgEls[id] = svg.querySelector('#' + id)
    })

    this.dom.micBtn.addEventListener('click', () => this.toggleListening())
    this.dom.liveBtn.addEventListener('click', () => this.toggleLive())
    // Text in the box always submits (preempting an autonomous pass in live
    // mode); an empty box while busy stops the current turn.
    this.dom.sendBtn.addEventListener('click', () =>
      this.dom.inputText.value.trim() ? this.submitInput() : (this.isBusy && this.stopThinking()))
    this.dom.inputText.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submitInput() }
    })
    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); this.toggleListening() }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedCards.size > 0 && e.target !== this.dom.inputText) {
        e.preventDefault()
        this.deleteSelectedCards()
      }
    })

    // Card click → toggle selection (delegated from the grid container)
    this.dom.dataArea.addEventListener('click', e => {
      const card = e.target.closest('.data-card')
      if (!card) return
      this.toggleCardSelection(card.id.replace(/^card-/, ''))
    })

    this.dom.selDelete.addEventListener('click', () => this.deleteSelectedCards())
    this.dom.selClear.addEventListener('click', () => this.clearSelection())
  }

  // ── Float positioning ─────────────────────────────────────────────
  // Compute a position for the orb near a card element. Returns {x,y}.
  // For large cards the focus point is clamped to the top portion so the orb
  // stays near the label rather than drifting to the center of a tall card.
  _nearCard(cardEl, gap = 14) {
    const rect = cardEl.getBoundingClientRect()
    const size = 88, vw = window.innerWidth, vh = window.innerHeight, inputH = 62

    // Focus point Y: top of card + min(half height, 60px) — keeps orb near header on tall cards
    const focusY = rect.top + Math.min(rect.height / 2, 60)
    let x = rect.right + gap
    let y = focusY - size / 2

    // When card fills the viewport width, float at right edge instead of going off-screen
    if (x + size > vw - 10) x = vw - size - 10

    return {
      x: Math.max(10, Math.min(x, vw - size - 10)),
      y: Math.max(10, Math.min(y, vh - inputH - size - 10)),
    }
  }

  // Position the orb adjacent to the specific element inside a card —
  // right next to the text, at its row. This is the laser-pointer effect.
  _nearElement(el, gap = 6) {
    if (!el?.closest?.('.data-card')) return null
    const elRect = el.getBoundingClientRect()
    const size = 88, vw = window.innerWidth, vh = window.innerHeight, inputH = 62

    let x = elRect.right + gap
    const y = elRect.top + elRect.height / 2 - size / 2

    // If element is near the right edge, sit to its left instead
    if (x + size > vw - 10) x = elRect.left - gap - size

    return {
      x: Math.max(10, Math.min(x, vw - size - 10)),
      y: Math.max(10, Math.min(y, vh - inputH - size - 10)),
    }
  }

  // Walk all text nodes inside data cards; return the parent element of the
  // first node whose text contains the given string (case-insensitive).
  findTextInCards(text) {
    if (!text) return null
    const lower = text.toLowerCase().trim()
    const walker = document.createTreeWalker(this.dom.dataArea, NodeFilter.SHOW_TEXT, null)
    let node
    while ((node = walker.nextNode())) {
      if (node.textContent.toLowerCase().includes(lower)) return node.parentElement
    }
    return null
  }

  // Wrap the exact matched substring in a <mark> element with the given class.
  // Returns the <mark>, or null if the text isn't found in any card.
  // Wrap the text of the FIRST matching card fragment (or, when an anchor
  // element is given, the fragment CLOSEST to that anchor) in a <mark>. Skips
  // text already inside another highlight so marks never nest.
  _wrapText(text, className = 'nomi-highlight', anchorEl = null) {
    if (!text) return null
    const lower = text.toLowerCase().trim()
    const walker = document.createTreeWalker(this.dom.dataArea, NodeFilter.SHOW_TEXT, null)
    let node
    const candidates = []
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('mark.nomi-highlight,mark.nomi-think-highlight,mark.nomi-think-scan')) continue
      const idx = node.textContent.toLowerCase().indexOf(lower)
      if (idx < 0) continue
      if (!anchorEl) return this._wrapNodeAt(node, idx, lower.length, className)  // first match
      candidates.push({ node, idx })
    }
    if (!candidates.length) return null
    // Pick the candidate whose parent sits closest to the anchor — so scanning
    // hops to the nearest instance of the word, not the first one on screen.
    const a = this._center(anchorEl)
    let best = candidates[0], bestD = Infinity
    for (const c of candidates) {
      const p = this._center(c.node.parentElement)
      const d = a && p ? Math.hypot(p.x - a.x, p.y - a.y) : 0
      if (d < bestD) { bestD = d; best = c }
    }
    return this._wrapNodeAt(best.node, best.idx, lower.length, className)
  }

  // Split a text node around [idx, idx+len) and wrap that slice in a <mark>.
  _wrapNodeAt(node, idx, len, className) {
    const matchNode = node.splitText(idx)          // matchNode starts at match
    matchNode.splitText(len)                        // matchNode is now exactly the match
    const mark = document.createElement('mark')
    mark.className = className
    matchNode.parentNode.insertBefore(mark, matchNode)
    mark.appendChild(matchNode)
    return mark
  }

  // Viewport-space centre of an element, or null if it has no box.
  _center(el) {
    const r = el?.getBoundingClientRect?.()
    if (!r || (!r.width && !r.height)) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  // The element proximity should cluster around: the last long-lived (quoted)
  // highlight, else the last transient scan, else the focused card / speech mark.
  _anchor() {
    return this._thinkMarks[this._thinkMarks.length - 1]
      ?? this._scanMarks[this._scanMarks.length - 1]
      ?? this._focusCardEl
      ?? this._highlightEl
      ?? null
  }

  // Remove a highlight <mark> and re-merge the surrounding text nodes.
  _unwrapMark(mark) {
    if (!mark?.parentNode) return
    const parent = mark.parentNode
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    mark.remove()
    parent.normalize()
  }

  // Swap the card-level focus highlight to cardEl (null to remove).
  // During reasoning, accumulated cards are managed via _thinkFocusCards instead.
  _applyCardFocus(cardEl) {
    if (this._focusCardEl === cardEl) return
    if (this._focusCardEl) this._focusCardEl.classList.remove('nomi-card-focus')
    this._focusCardEl = cardEl || null
    if (cardEl) cardEl.classList.add('nomi-card-focus')
  }

  // Focus on specific text inside a card: wrap the exact text in a highlight
  // <mark>, move the orb to sit beside it, and lock the eye to it.
  // CSS :has() automatically highlights the parent row and card — no JS needed for those.
  focusText(text) {
    if (this._highlightEl) { this._unwrapMark(this._highlightEl); this._highlightEl = null }
    const mark = this._wrapText(text)
    console.log('[nomi] focusText:', JSON.stringify(text), mark ? 'found' : 'NOT FOUND in cards')
    if (!mark) return
    this._highlightEl = mark
    this.lookTargetEl = mark
    this.orbLerpK = 0.04
    mark.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  clearHighlight() {
    if (this._highlightEl) { this._unwrapMark(this._highlightEl); this._highlightEl = null }
    this._applyCardFocus(null)
    if (this.lookTargetEl && !this.lookTargetEl.isConnected) this.lookTargetEl = null
  }

  // Long-lived highlight for a QUOTED term during reasoning — accumulates until
  // the response starts. Prefers the instance nearest the current anchor so
  // related terms cluster. Uses a very slow orb blend toward their centroid.
  focusThinkText(text) {
    const mark = this._wrapText(text, 'nomi-think-highlight', this._anchor())
    if (!mark) return
    this._thinkMarks.push(mark)
    // Blend orbTarget 20% toward the highlighted element — repeated calls average out
    const pos = this._nearElement(mark) ?? (mark.closest('.data-card') ? this._nearCard(mark.closest('.data-card')) : null)
    if (pos) {
      this.orbTarget.x += (pos.x - this.orbTarget.x) * 0.2
      this.orbTarget.y += (pos.y - this.orbTarget.y) * 0.2
      this.orbLerpK = 0.015   // slow drift — orb can't keep up with rapid reasoning
    }
  }

  // Accumulating light highlight for a NON-quoted word Nomí mentions while
  // reasoning that also appears on a card — the "scanning the UI" effect. Picks
  // the instance closest to the current anchor and nudges the orb toward it, then
  // leaves it in place. Think-highlights accumulate through the whole reasoning
  // phase so the user sees roughly what Nomí looked at; they all fade together
  // once Nomí starts speaking (fadeThinkHighlights).
  flickerThinkText(word) {
    const mark = this._wrapText(word, 'nomi-think-scan', this._anchor())
    if (!mark) return
    this._scanMarks.push(mark)
    const pos = this._nearElement(mark) ?? (mark.closest('.data-card') ? this._nearCard(mark.closest('.data-card')) : null)
    if (pos) {
      this.orbTarget.x += (pos.x - this.orbTarget.x) * 0.25
      this.orbTarget.y += (pos.y - this.orbTarget.y) * 0.25
      this.orbLerpK = 0.02
    }
  }

  // Significant words currently visible on cards, used to decide which reasoning
  // words are worth flickering. Rebuilt lazily whenever the board changes.
  cardWords() {
    if (this._cardWords) return this._cardWords
    const set = new Set()
    const add = v => { for (const w of significantWords(String(v ?? ''))) set.add(w) }
    for (const card of this.clientCards.values()) {
      add(card.label); add(card.value); add(card.unit); add(card.detail)
      if (Array.isArray(card.rows)) for (const row of card.rows) for (const v of Object.values(row ?? {})) add(v)
    }
    return (this._cardWords = set)
  }

  // Queue each card word Nomí mentions this reasoning chunk for a light
  // highlight. Each word is highlighted only once and then accumulates for the
  // rest of the reasoning phase — the point is to show roughly what Nomí looked
  // at, not to re-light words as they recur.
  flickerReasoningWords(text) {
    const words = this.cardWords()
    if (!words.size) return
    for (const w of significantWords(text)) {
      if (!words.has(w)) continue
      if (this._recentScans.has(w)) continue   // already highlighted — leave it in place
      this._recentScans.set(w, 1)
      this._queueThink('scan', w)
    }
  }

  // Reveal reasoning highlights one at a time at a human "scanning" pace, so a
  // fast token stream never strobes the whole board at once. Quotes become
  // long-lived think-highlights; other card words get a short-lived flicker.
  _queueThink(kind, text) {
    this._thinkQueue.push({ kind, text })
    // Cap the backlog so the reveal never lags far behind the thinking: drop the
    // oldest transient scan first, keeping the rarer, more meaningful quotes.
    if (this._thinkQueue.length > 18) {
      const i = this._thinkQueue.findIndex(x => x.kind === 'scan')
      this._thinkQueue.splice(i >= 0 ? i : 0, 1)
    }
    if (!this._thinkTimer) this._pumpThink()
  }

  _pumpThink() {
    const item = this._thinkQueue.shift()
    if (!item) { this._thinkTimer = null; return }
    if (item.kind === 'quote') this.focusThinkText(item.text)
    else this.flickerThinkText(item.text)
    this._thinkTimer = setTimeout(() => this._pumpThink(), THINK_PACE_MS)
  }

  _stopThinkPacer() {
    clearTimeout(this._thinkTimer)
    this._thinkTimer = null
    this._thinkQueue = []
  }

  // Stream reasoning into the fixed-size thought cloud beside the orb as a
  // ticker: words append to the line and it slides left so the newest ones stay
  // in view, scrolling older words off the left edge. The box never resizes.
  showThinkCloud(text) {
    if (!this.dom.thinkCloud) return
    this._thinkCloudBuf = `${this._thinkCloudBuf} ${text}`.replace(/\s+/g, ' ').slice(-THINK_CLOUD_MAX).trimStart()
    const el = this.dom.thinkCloudText
    el.textContent = this._thinkCloudBuf
    this.dom.thinkCloud.classList.add('visible')
    this._thinkCloudSeenAt = performance.now()
    // Slide the line so its right (newest) end sits at the window's right edge.
    const overflow = el.scrollWidth - this.dom.thinkCloudView.clientWidth
    el.style.transform = overflow > 0 ? `translateX(${-overflow}px)` : 'translateX(0)'
  }

  hideThinkCloud(instant = false) {
    if (!this.dom.thinkCloud) return
    clearTimeout(this._thinkCloudHideT)
    this._thinkCloudBuf = ''
    if (instant) {
      this.dom.thinkCloud.classList.remove('visible')
      this.dom.thinkCloudText.textContent = ''
      this.dom.thinkCloudText.style.transform = 'translateX(0)'
      return
    }
    // Guarantee a minimum on-screen dwell: when the whole reasoning+response
    // stream arrives in one burst (fast local models, debug logging off), the
    // cloud would otherwise be shown and hidden in the same synchronous task
    // and never paint. Deferring the hide keeps it visible regardless.
    const wait = Math.max(0, 900 - (performance.now() - (this._thinkCloudSeenAt ?? 0)))
    this._thinkCloudHideT = setTimeout(() => {
      this.dom.thinkCloud.classList.remove('visible')
      setTimeout(() => {
        if (!this.dom.thinkCloud.classList.contains('visible')) {
          this.dom.thinkCloudText.textContent = ''
          this.dom.thinkCloudText.style.transform = 'translateX(0)'
        }
      }, 300)
    }, wait)
  }

  // Remove all accumulated think-highlight marks and card focuses instantly (used at message start).
  clearThinkHighlights() {
    this._stopThinkPacer()
    for (const mark of this._thinkMarks) this._unwrapMark(mark)
    this._thinkMarks = []
    this._scanMarks = []
    this._recentScans.clear()
    this._cardWords = null
    for (const mark of this.dom.dataArea.querySelectorAll('mark.nomi-think-highlight, mark.nomi-think-scan')) {
      this._unwrapMark(mark)
    }
    for (const card of this._thinkFocusCards) {
      card.classList.remove('nomi-card-focus')
      if (this._focusCardEl === card) this._focusCardEl = null
    }
    this._thinkFocusCards.clear()
  }

  // CSS-fade all accumulated think highlights (quoted terms AND light word
  // matches) out together, then unwrap them. Called when the first TTS sentence
  // starts playing — the whole "what Nomí looked at" picture dissolves as Nomi
  // begins to speak, handing the board over to the speech-paced highlights.
  fadeThinkHighlights() {
    const marks = [...this._thinkMarks, ...this._scanMarks]
    if (!marks.length) return
    this._thinkMarks = []
    this._scanMarks = []
    for (const mark of marks) {
      mark.classList.add(mark.classList.contains('nomi-think-scan') ? 'nomi-think-scan-fading' : 'nomi-think-fading')
    }
    setTimeout(() => {
      for (const mark of marks) this._unwrapMark(mark)
    }, 750)
  }

  // Pull complete quoted terms out of streaming text, returning the text with
  // the quote marks removed plus the list of quoted terms. A trailing open
  // quote is held back in `this[key]` so a term split across chunks isn't lost.
  extractQuotes(text, key) {
    let buf = this[key] + text
    const quotes = []
    let m
    QUOTE_RE.lastIndex = 0
    while ((m = QUOTE_RE.exec(buf)) !== null) {
      const ref = (m[1] ?? m[2] ?? m[3]).trim()
      quotes.push(ref)
      buf = buf.slice(0, m.index) + ref + buf.slice(m.index + m[0].length)
      QUOTE_RE.lastIndex = 0
    }
    const openAt = lastOpenQuote(buf)
    if (openAt >= 0 && buf.length - openAt <= 60) { this[key] = buf.slice(openAt); return { text: buf.slice(0, openAt), quotes } }
    this[key] = ''
    return { text: buf, quotes }
  }

  // Glance toward a card when its id or label is mentioned in the given text.
  scanForCard(text, key) {
    this[key] = (this[key] + text).slice(-150)
    const lower = this[key].toLowerCase()
    for (const [id, card] of this.clientCards) {
      const label = card.label?.toLowerCase()
      const hit = lower.includes(id.toLowerCase())
        || (label && label.length >= 4 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower))
      if (hit) {
        if (id !== this._lastGlanceId) { this._lastGlanceId = id; this.glanceAt(`card-${id}`) }
        return
      }
    }
  }

  resetStreamBuffers() {
    this._tokenQuoteBuf = this._reasonQuoteBuf = this._speechScanBuf = this._reasonScanBuf = ''
    this._lastGlanceId = null
    this._thinkCloudBuf = ''
    if (this.dom?.thinkCloudText) this.dom.thinkCloudText.style.transform = 'translateX(0)'
    this._recentScans.clear()
    this._cardWords = null
  }

  placeHome() {
    const inputH = 62, size = 88
    const x = window.innerWidth  - size - 22
    const y = window.innerHeight - inputH - size - 18
    this.orbTarget = { x, y }
    this.orbLerpK  = 0.06
    if (!this.orbPos) this.orbPos = { x, y }   // hard-set on first call
  }

  // ── Session ───────────────────────────────────────────────────────
  async startSession() {
    try {
      const res  = await fetch(`${API}/startSession`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const data = await res.json()
      this.sessionId = (data.value ?? data).ID
    } catch (err) {
      console.error('Session start failed:', err)
      this.setStatus('error', 'Connection failed')
    }
  }

  // ── Speech recognition ────────────────────────────────────────────
  setupSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { console.info('SpeechRecognition not available'); return }

    this.recognition = new SR()
    this.recognition.continuous     = true
    this.recognition.interimResults = true
    this.recognition.lang           = navigator.language || 'en-US'

    this.recognition.onstart = () => { this._recognizing = true }

    let interimDebounce = null
    this.recognition.onresult = e => {
      let interim = '', final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        e.results[i].isFinal ? (final += t) : (interim += t)
      }
      if (interim) {
        this.dom.inputText.value = interim
        clearTimeout(interimDebounce)
        interimDebounce = setTimeout(() => this.setExpr('focused', 0), 150)
      }
      if (final) {
        this.dom.inputText.value = ''
        this.sendMessage(final.trim())
      }
    }

    this.recognition.onerror = e => {
      this._recognizing = false
      if (e.error === 'no-speech') return
      if (e.error === 'audio-capture' || e.error === 'not-allowed') {
        this.isListening = false
        this.dom.micBtn.classList.remove('active')
        this.dom.micBtn.textContent = '🎤'
        this.setStatus('ready', e.error === 'not-allowed' ? 'Mic denied' : 'Mic unavailable')
        return
      }
      console.warn('STT:', e.error)
    }

    this.recognition.onend = () => {
      this._recognizing = false
      if (!this.isListening) return
      // Small delay prevents rapid restart loops on transient errors
      clearTimeout(this._restartTimer)
      this._restartTimer = setTimeout(() => {
        if (this.isListening && !this._recognizing) {
          try { this.recognition.start() } catch (err) { console.warn('STT restart:', err.message) }
        }
      }, 250)
    }
  }

  toggleListening() {
    if (!this.recognition) return
    // Prime AudioContext on user gesture so TTS can play later
    this.ttsQueue.prime()

    if (this.isListening) {
      this.isListening = false
      clearTimeout(this._restartTimer)
      if (this._recognizing) try { this.recognition.stop() } catch {}
      this._recognizing = false
      this.dom.micBtn.classList.remove('active')
      this.dom.micBtn.textContent = '🎤'
      this.setStatus('ready', 'Ready')
    } else {
      this.isListening = true
      if (!this._recognizing) {
        try {
          this.recognition.start()
        } catch (err) {
          console.warn('STT start:', err.message)
          this.isListening = false
          return
        }
      }
      this.dom.micBtn.classList.add('active')
      this.dom.micBtn.textContent = '🔴'
      this.setStatus('listen', 'Listening…')
    }
  }

  // ── Live mode ─────────────────────────────────────────────────────
  // A user-toggled autonomous loop: while on, Nomí runs a silent refine pass
  // whenever it is idle, then schedules the next one. The server supplies the
  // refine directive for these `auto` turns; the client stays quiet (no TTS).
  toggleLive() {
    this.live = !this.live
    this.dom.liveBtn.classList.toggle('active', this.live)
    this.dom.liveBtn.textContent = this.live ? '🟢 Live' : '○ Live'
    if (this.live) { if (!this.isBusy) this._scheduleRefine(600) }
    else clearTimeout(this._liveTimer)
  }

  _scheduleRefine(delay = LIVE_REFINE_MS) {
    clearTimeout(this._liveTimer)
    if (!this.live) return
    this._liveTimer = setTimeout(() => {
      if (this.live && !this.isBusy && !this._pendingMessage) this.sendMessage(null, { auto: true })
    }, delay)
  }

  // ── Message flow ──────────────────────────────────────────────────
  submitInput() {
    const text = this.dom.inputText.value.trim()
    if (!text) return
    this.dom.inputText.value = ''
    this.sendMessage(text)
  }

  stopThinking() {
    this._abortController?.abort()
  }

  _showPromptBubble(text) {
    this.dom.promptBubble.textContent = text.trim()
    this.dom.responseWrap.classList.add('visible')
  }

  _addSpeechBubble(text) {
    const t = text.trim()
    if (!t) return
    const el = document.createElement('span')
    el.className = 'speech-bubble'
    el.textContent = t
    this.dom.speechBubbles.appendChild(el)
    this._speechBubbles.push(el)
    this.dom.responseWrap.classList.add('visible')
  }

  _clearSpeechBubbles() {
    this._speechBubbles = []
    this.dom.speechBubbles.innerHTML = ''
    this.dom.promptBubble.textContent = ''
    this.dom.responseWrap.classList.remove('visible')
  }

  _getCarryOverText() {
    return [...this.dom.speechBubbles.querySelectorAll('.speech-bubble.selected')]
      .map(el => el.textContent.replace(/ ✓$/, '').trim()).filter(Boolean).join(' ')
  }

  async sendMessage(text, { auto = false } = {}) {
    if (!this.sessionId) return
    if (!text && !auto) return
    if (this.isBusy) {
      // Never queue autonomous passes — the loop will fire again once idle.
      if (auto) return
      this._pendingMessage = this._pendingMessage
        ? this._pendingMessage + '\n' + text
        : text
      // A user message preempts an autonomous pass: cancel it so the user's
      // message runs immediately (the finally block then sends _pendingMessage).
      // A real user turn is left to finish.
      if (this._autoInFlight) this._abortController?.abort()
      return
    }
    this.isBusy = true
    this._autoInFlight = auto
    this._abortController = new AbortController()
    this.dom.sendBtn.textContent = 'Stop'
    this.dom.sendBtn.classList.add('stop-mode')

    // Collect carry-over from selected speech bubbles, then reset the strip
    const carryOver = auto ? '' : this._getCarryOverText()
    this._clearSpeechBubbles()
    if (!auto) this._showPromptBubble(text)

    // Return home when the user speaks — stay there until show_data moves us
    this.lookTargetId = null
    this.lookTargetEl = null
    this.clearHighlight()
    this.clearThinkHighlights()
    this.resetStreamBuffers()
    this.hideThinkCloud(true)
    this._thinkingMode = true
    this.placeHome()

    // Prime AudioContext and cancel any ongoing speech
    this.ttsQueue.prime()
    this.ttsQueue.cancel()
    this.ttsQueue.prime() // re-prime after cancel (ctx stays alive)

    this.setStatus('busy', 'Thinking…')
    this.setExpr('thinking', 0)

    let ttsBuf = ''
    let pendingHighlights = []   // collected from «guillemet» events, attached to next TTS sentence

    // Wraps any TTS onPlayStart callback to fade think-highlights on the first audio play.
    // After the first fire it becomes a transparent pass-through.
    let thinkFadeDone = false
    const wrapWithFade = (cb) => {
      if (thinkFadeDone) return cb
      return (duration) => {
        if (!thinkFadeDone) { thinkFadeDone = true; this.fadeThinkHighlights() }
        if (cb) cb(duration)
      }
    }

    try {
      // If the user has selected cards, prepend their content as context then clear selection
      let msgToSend = text
      if (!auto && this.selectedCards.size > 0) {
        const refs = [...this.selectedCards].map(id => {
          const card = this.clientCards.get(id)
          if (!card) return null
          return `[${card.label}]\n${String(card.value ?? '').slice(0, 400).trim()}`
        }).filter(Boolean)
        if (refs.length) msgToSend = refs.join('\n\n') + '\n\n' + text
        this.clearSelection()
      }
      if (carryOver) msgToSend = `[context: "${carryOver}"]\n\n` + msgToSend

      const res = await fetch(`${API}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sessionId: this.sessionId,
          message:   auto ? '' : msgToSend,
          auto,
          cards:     JSON.stringify([...this.clientCards.values()]),
        }),
        signal:  this._abortController.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader  = res.body.getReader()
      // Aborting the fetch does not reliably reject an in-progress reader.read()
      // in every browser, which would hang the turn and starve any queued user
      // message. Cancel the reader on abort so the read loop exits deterministically.
      this._abortController.signal.addEventListener(
        'abort', () => { reader.cancel().catch(() => {}) }, { once: true })
      const decoder = new TextDecoder()
      let lineBuf = '', done = false

      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        lineBuf += decoder.decode(chunk.value, { stream: true })
        const lines = lineBuf.split('\n'); lineBuf = lines.pop()

        for (const line of lines) {
          if (!line.trim()) continue
          let evt; try { evt = JSON.parse(line) } catch { continue }

          if (evt.type === 'token') {
            // Reasoning phase over — stop the slow orb blend; think-highlights stay
            // until the first TTS sentence starts playing (see wrapWithFade below)
            if (this._thinkingMode) {
              this._thinkingMode = false
              this._stopThinkPacer()   // hand highlighting over to the TTS-paced speech path
              this.hideThinkCloud()
              if (this.baseExpr === 'thinking') this.setExpr('neutral', 0)
            }
            // Autonomous passes are silent — never speak or show a speech bubble.
            if (auto) continue
            // Pull quoted terms out for highlighting; the cleaned text (no quote
            // marks) is what gets spoken and shown.
            const { text, quotes } = this.extractQuotes(evt.text, '_tokenQuoteBuf')
            pendingHighlights.push(...quotes)
            if (!text) { continue }
            this.scanForCard(text, '_speechScanBuf')
            ttsBuf += text
            const [complete, rest] = sentenceSplit(ttsBuf)
            if (complete) {
              const hl = pendingHighlights.splice(0)
              // Build a callback that fires each highlight proportionally when
              // its text is approximately being spoken within the sentence audio.
              const cb = hl.length ? (duration) => {
                const lower = complete.toLowerCase()
                hl.forEach(t => {
                  const pos = lower.indexOf(t.toLowerCase())
                  const frac = pos >= 0 ? pos / complete.length : 0
                  setTimeout(() => this.focusText(t), Math.round(frac * duration * 1000))
                })
              } : null
              this.ttsQueue.enqueue(complete, wrapWithFade(cb))
              this._addSpeechBubble(complete)
              ttsBuf = rest
            } else if (ttsBuf.length >= 300) {
              const hl = pendingHighlights.splice(0)
              const cb = hl.length ? (duration) => {
                const lower = ttsBuf.toLowerCase()
                hl.forEach(t => {
                  const pos = lower.indexOf(t.toLowerCase())
                  const frac = pos >= 0 ? pos / ttsBuf.length : 0
                  setTimeout(() => this.focusText(t), Math.round(frac * duration * 1000))
                })
              } : null
              this.ttsQueue.enqueue(ttsBuf.trim(), wrapWithFade(cb))
              this._addSpeechBubble(ttsBuf.trim())
              ttsBuf = ''
            }
          }

          this.handleEvent(evt)
          if (evt.type === 'flush') { done = true; break }
        }
      }
      ttsBuf += this._tokenQuoteBuf; this._tokenQuoteBuf = ''  // flush any held-back tail
      if (!auto && ttsBuf.trim()) {
        const hl = pendingHighlights.splice(0)
        const cb = hl.length ? (duration) => {
          const lower = ttsBuf.toLowerCase()
          hl.forEach(t => {
            const pos = lower.indexOf(t.toLowerCase())
            const frac = pos >= 0 ? pos / ttsBuf.length : 0
            setTimeout(() => this.focusText(t), Math.round(frac * duration * 1000))
          })
        } : null
        this.ttsQueue.enqueue(ttsBuf.trim(), wrapWithFade(cb))
        this._addSpeechBubble(ttsBuf.trim())
      }

    } catch (err) {
      if (err.name !== 'AbortError') console.error('sendMessage:', err)
    } finally {
      this._thinkingMode = false
      this.isBusy = false
      this._abortController = null
      this.dom.sendBtn.textContent = 'Send'
      this.dom.sendBtn.classList.remove('stop-mode')
      this.setStatus(this.isListening ? 'listen' : 'ready', this.isListening ? 'Listening…' : 'Ready')
      if (this._pendingMessage) {
        const pending = this._pendingMessage
        this._pendingMessage = null
        this.sendMessage(pending)
      } else if (this.live) {
        // Live mode: queue the next autonomous refine pass once the board settles.
        this._scheduleRefine()
      }
    }
  }

  // The server streams a flat set of events; the client derives every visual
  // cue itself (highlights, glances, expressions) from the raw text.
  handleEvent(evt) {
    switch (evt.type) {
      case 'reasoning': {
        // Whole reasoning stream. Quoted terms get long-lived highlights; every
        // other UI-visible word gets a short-lived flicker (the "scanning" look);
        // emojis nudge the expression; the raw text streams into the think cloud.
        const { text, quotes } = this.extractQuotes(evt.text, '_reasonQuoteBuf')
        for (const q of quotes) this._queueThink('quote', q)
        this.showThinkCloud(evt.text)
        if (text) {
          const expr = firstEmojiExpr(text)
          if (expr) this.setExpr(expr, 3000)
          this.scanForCard(text, '_reasonScanBuf')
          this.flickerReasoningWords(text)
        }
        break
      }
      case 'data-point': {
        // Card created/updated — new cards get a decisive look, updates a glance.
        const isNew = !this.clientCards.has(evt.id)
        this.clientCards.set(evt.id, evt)
        this._cardWords = null   // board changed — rebuild the scan word index
        this.renderCard(evt)
        if (isNew) this.lookAt(`card-${evt.id}`)
        break
      }
      case 'remove': if (evt.id) this.removeCard(evt.id); break
      case 'error':  console.warn('nomi server error:', evt.message); break
      case 'flush':
        this.setExpr('happy', 4500)
        this._stopThinkPacer()      // drop any un-revealed reasoning highlights
        this.hideThinkCloud()
        this.fadeThinkHighlights()  // no-op if already faded by TTS; fallback if TTS never played
        // Keep the last speech highlight visible briefly so the user can see what was discussed
        setTimeout(() => this.clearHighlight(), 2000)
        break
    }
  }

  // ── Data cards ────────────────────────────────────────────────────
  removeCard(id) {
    const elId = `card-${id}`
    const card = document.getElementById(elId)
    if (card) {
      if (this.lookTargetEl && card.contains(this.lookTargetEl)) this.lookTargetEl = null
      if (this._highlightEl && card.contains(this._highlightEl)) this._highlightEl = null
      if (this._focusCardEl === card) this._focusCardEl = null
      card.remove()
    }
    if (this.lookTargetId === elId) {
      this.lookTargetId = null
      this.placeHome()
    }
    this.clientCards.delete(id)
    this._cardWords = null   // board changed — rebuild the scan word index
    if (this.selectedCards.delete(id)) this.updateSelectionBar()
  }

  toggleCardSelection(id) {
    const card = document.getElementById(`card-${id}`)
    if (!card) return
    if (this.selectedCards.has(id)) {
      this.selectedCards.delete(id)
      card.classList.remove('user-selected')
    } else {
      this.selectedCards.add(id)
      card.classList.add('user-selected')
    }
    this.updateSelectionBar()
  }

  updateSelectionBar() {
    const n = this.selectedCards.size
    if (n === 0) {
      this.dom.selBar.classList.remove('visible')
    } else {
      this.dom.selBar.classList.add('visible')
      this.dom.selCount.textContent =
        `${n} card${n > 1 ? 's' : ''} selected — included in next message`
    }
  }

  clearSelection() {
    for (const id of this.selectedCards) {
      document.getElementById(`card-${id}`)?.classList.remove('user-selected')
    }
    this.selectedCards.clear()
    this.updateSelectionBar()
  }

  // The server keeps no card state — removing locally is enough; the next
  // message carries the updated card set.
  deleteSelectedCards() {
    const ids = [...this.selectedCards]
    this.clearSelection()
    for (const id of ids) this.removeCard(id)
  }
  renderCard(data) {
    const { id, label, value, dtype, unit, trend, detail, span } = data
    const elId = `card-${id}`
    let card = document.getElementById(elId)
    const isNew = !card
    if (!card) {
      card = document.createElement('div')
      card.id = elId; card.className = 'data-card'
      this.dom.dataArea.appendChild(card)
    }
    // If a highlight mark lives inside this card, clear it before re-rendering
    if (this._highlightEl && card.contains(this._highlightEl)) {
      this._highlightEl = null
      if (this.lookTargetEl && !this.lookTargetEl.isConnected) this.lookTargetEl = null
    }

    // Apply span (grid-column control)
    if (span && span !== '1') card.dataset.span = span
    else delete card.dataset.span

    card.classList.remove('active'); void card.offsetWidth

    const sym = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
    const tc  = trend === 'up' ? 'up' : trend === 'down' ? 'down' : 'neutral'

    if (dtype === 'metric') {
      card.innerHTML = `
        <div class="card-label">${esc(label)}</div>
        <div class="card-value">${esc(value)}${unit ? `<span class="card-unit">${esc(unit)}</span>` : ''}</div>
        ${trend  ? `<div class="card-trend ${tc}">${sym} ${tc}</div>` : ''}
        ${detail ? `<div class="card-detail">${esc(detail)}</div>` : ''}
      `
    } else if (dtype === 'progress') {
      const pct = parseFloat(value) || 0
      card.innerHTML = `
        <div class="card-label">${esc(label)}</div>
        <div class="card-value" style="font-size:18px">${esc(value)}${unit ? `<span class="card-unit">${esc(unit)}</span>` : ''}</div>
        <div class="card-prog-bar"><div class="card-prog-fill" style="width:${Math.min(pct,100)}%"></div></div>
        ${detail ? `<div class="card-detail">${esc(detail)}</div>` : ''}
      `
    } else if (dtype === 'markdown') {
      card.innerHTML = `
        <div class="card-label">${esc(label)}</div>
        <div class="card-md">${renderMarkdown(value)}</div>
        ${detail ? `<div class="card-detail">${esc(detail)}</div>` : ''}
      `
    } else if (dtype === 'table') {
      card.innerHTML = `
        <div class="card-label">${esc(label)}</div>
        <div class="card-md">${renderTable(data.rows)}</div>
        ${detail ? `<div class="card-detail">${esc(detail)}</div>` : ''}
      `
    } else {
      card.innerHTML = `
        <div class="card-label">${esc(label)}</div>
        <div class="card-text-val">${esc(value)}</div>
        ${detail ? `<div class="card-detail">${esc(detail)}</div>` : ''}
      `
    }
    setTimeout(() => card.classList.add('active'), 10)
    setTimeout(() => card.classList.remove('active'), 2200)
    // Scroll new cards into view so they're never hidden off the bottom
    if (isNew) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40)
  }

  // ── Eye look-at ───────────────────────────────────────────────────
  // Full move: decisive snap to beside the card (tool-call driven).
  lookAt(cardId) {
    this.lookTargetEl = null
    this.lookTargetId = cardId
    this.orbLerpK = 0.08
    const card = document.getElementById(cardId)
    this._applyCardFocus(card)
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  // Glance: slow drift toward the card (reasoning/speech driven)
  glanceAt(cardId) {
    this.lookTargetEl = null
    this.lookTargetId = cardId
    this.orbLerpK = 0.025
    const card = document.getElementById(cardId)
    if (this._thinkingMode && card) {
      // During reasoning: accumulate focus on every visited card rather than swapping
      this._thinkFocusCards.add(card)
      card.classList.add('nomi-card-focus')
    } else {
      this._applyCardFocus(card)
    }
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  updateEyeLook() {
    const target = this.lookTargetEl || (this.lookTargetId ? document.getElementById(this.lookTargetId) : null)
    const [eox, eoy] = this.exprIrisOff

    if (!target || !this.svgEl) { this.setIrisOffset(eox, eoy); return }

    const svgRect  = this.svgEl.getBoundingClientRect()
    const tRect    = target.getBoundingClientRect()
    const svgCX = svgRect.left + svgRect.width  * 0.5
    const svgCY = svgRect.top  + svgRect.height * 0.47
    const tCX   = tRect.left + tRect.width  * 0.5
    const tCY   = tRect.top  + tRect.height * 0.5

    const dx  = tCX - svgCX, dy = tCY - svgCY
    const ang = Math.atan2(dy, dx)
    const k   = Math.min(Math.sqrt(dx*dx + dy*dy) / 300, 1)

    this.setIrisOffset(Math.cos(ang) * k * 3 + eox, Math.sin(ang) * k * 2.5 + eoy)
  }

  setIrisOffset(ox, oy) {
    ;['l','r'].forEach(s => {
      const iris  = this.svgEls[`iris-${s}`]
      const pupil = this.svgEls[`pupil-${s}`]
      if (!iris || !pupil) return
      iris.setAttribute('cx',  ox);  iris.setAttribute('cy',  1 + oy)
      pupil.setAttribute('cx', ox); pupil.setAttribute('cy', 1.5 + oy)
    })
  }

  // ── Expressions ───────────────────────────────────────────────────
  setExpr(name, duration) {
    if (!EXPR[name]) return
    this.curExpr = name
    this.applyExpr(name)
    clearTimeout(this.exprTimer)
    if (duration > 0) {
      // Micro-expression: snap back to the current base when it expires
      this.exprTimer = setTimeout(() => this.setExpr(this.baseExpr, 0), duration)
    } else {
      // Permanent expression: becomes the new base
      this.baseExpr = name
    }
  }

  applyExpr(name) {
    const e = EXPR[name] || EXPR.neutral
    ALL_GLOW.forEach(c => this.dom.nomiFloat.classList.remove(c))
    if (e.glowClass) this.dom.nomiFloat.classList.add(e.glowClass)

    ;['l','r'].forEach(s => {
      const sc    = this.svgEls[`sclera-${s}`]
      const iris  = this.svgEls[`iris-${s}`]
      const pupil = this.svgEls[`pupil-${s}`]
      if (!sc || !iris || !pupil) return
      sc.setAttribute('ry', e.scleraRY)
      sc.setAttribute('cy', e.scleraCY)
      iris.setAttribute('ry', e.irisRY);  iris.setAttribute('rx', e.irisRY)
      pupil.setAttribute('ry', e.pupilRY); pupil.setAttribute('rx', e.pupilRY)
    })

    this.exprIrisOff = e.irisOff || [0, 0]
  }

  // ── Idle animation ─────────────────────────────────────────────────
  setupAnimationLoop() {
    const blink = () => {
      setTimeout(() => {
        ;['l','r'].forEach(s => {
          const sc = this.svgEls[`sclera-${s}`]
          if (!sc) return
          const baseRY = parseFloat(sc.getAttribute('ry')) || 9
          sc.setAttribute('ry', '0.5')
          setTimeout(() => sc.setAttribute('ry', String(baseRY)), 130)
        })
        blink()
      }, 2500 + Math.random() * 3500)
    }
    blink()

    let t = 0
    const wander = () => {
      // ── Eyes + continuous orb target tracking ──
      const [eox, eoy] = this.exprIrisOff
      if (this.lookTargetEl) {
        // Element-level focus: eyes + orb aligned to specific text within a card
        this.updateEyeLook()
        const pos = this._nearElement(this.lookTargetEl)
        if (pos) { this.orbTarget.x = pos.x; this.orbTarget.y = pos.y }
      } else if (this.lookTargetId) {
        this.updateEyeLook()
        // During thinking, keep eye direction but don't snap the orb to the card —
        // think-highlight blending controls orb position instead.
        if (!this._thinkingMode) {
          const card = document.getElementById(this.lookTargetId)
          if (card) {
            const pos = this._nearCard(card)
            this.orbTarget.x = pos.x
            this.orbTarget.y = pos.y
          }
        }
      } else {
        t += 0.007
        this.setIrisOffset(Math.sin(t * 1.2) * 1.5 + eox, Math.cos(t * 0.85) * 1.0 + eoy)
      }

      // ── Orb lerp + micro-wobble ──
      // The wobble keeps Nomi always subtly moving — never fully still.
      // Speed (orbLerpK) varies by event: 0.025 glance drift · 0.06 home · 0.08 snap
      if (this.orbPos) {
        const now = Date.now()
        const tx = this.orbTarget.x + Math.sin(now / 1100) * 2.5
        const ty = this.orbTarget.y + Math.cos(now / 900)  * 1.5
        this.orbPos.x += (tx - this.orbPos.x) * this.orbLerpK
        this.orbPos.y += (ty - this.orbPos.y) * this.orbLerpK
        this.dom.nomiFloat.style.left = this.orbPos.x + 'px'
        this.dom.nomiFloat.style.top  = this.orbPos.y + 'px'
      }

      requestAnimationFrame(wander)
    }
    requestAnimationFrame(wander)

    window.addEventListener('resize', () => {
      if (this.lookTargetId) {
        // Recalculate target for the card at its new position
        const card = document.getElementById(this.lookTargetId)
        if (card) this.orbTarget = this._nearCard(card)
        else this.placeHome()
      } else {
        this.placeHome()
      }
    })
  }

  // ── Status ────────────────────────────────────────────────────────
  setStatus(state, text) {
    this.dom.statusDot.className  = state
    this.dom.statusText.textContent = text
  }
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// Renders a small subset of markdown to safe HTML.
// Only inline escaping is done first, so no XSS from < > & in input.
function renderMarkdown(text) {
  const inline = s => s
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

  const isSep  = r => /^\|(\s*:?-+:?\s*\|)+$/.test(r.trim())
  const splitRow = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

  function flushTable(rows) {
    if (!rows.length) return ''
    const sepIdx = rows.findIndex(isSep)
    let out = '<table>'
    if (sepIdx === 1) {
      out += '<thead><tr>' + splitRow(rows[0]).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>'
      out += '<tbody>'
      for (let i = 2; i < rows.length; i++) {
        if (!isSep(rows[i])) out += '<tr>' + splitRow(rows[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'
      }
    } else {
      out += '<tbody>'
      for (const r of rows) {
        if (!isSep(r)) out += '<tr>' + splitRow(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'
      }
    }
    return out + '</tbody></table>'
  }

  const lines = String(text ?? '').split('\n')
  let html = '', inList = false, listTag = '', inCode = false, codeBuf = '', tableBuf = []

  const endList  = () => { if (inList)    { html += `</${listTag}>`; inList = false } }
  const endTable = () => { if (tableBuf.length) { html += flushTable(tableBuf); tableBuf = [] } }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.startsWith('```')) {
      if (inCode) {
        html += `<pre><code>${esc(codeBuf.replace(/^\n/, ''))}</code></pre>`
        codeBuf = ''; inCode = false
      } else {
        endList(); endTable(); inCode = true
      }
      continue
    }
    if (inCode) { codeBuf += raw + '\n'; continue }

    if (line.startsWith('|')) {
      endList()
      tableBuf.push(line)
      continue
    }

    endTable()

    if (/^-{3,}$/.test(line.trim())) {
      endList()
      html += '<hr>'
    } else if (/^#{1,4}\s/.test(line)) {
      endList()
      const lvl = line.match(/^(#+)/)[1].length
      const tag = lvl <= 3 ? 'h3' : 'h4'
      html += `<${tag}>${inline(line.replace(/^#+\s+/, ''))}</${tag}>`
    } else if (/^[-*]\s/.test(line)) {
      if (!inList || listTag !== 'ul') {
        if (inList) html += `</${listTag}>`
        html += '<ul>'; inList = true; listTag = 'ul'
      }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`
    } else if (/^\d+\.\s/.test(line)) {
      if (!inList || listTag !== 'ol') {
        if (inList) html += `</${listTag}>`
        html += '<ol>'; inList = true; listTag = 'ol'
      }
      html += `<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`
    } else if (line === '') {
      endList()
    } else {
      endList()
      html += `<p>${inline(line)}</p>`
    }
  }
  endList(); endTable()
  if (inCode) html += `<pre><code>${esc(codeBuf)}</code></pre>`
  return html
}

// ── Stream text helpers ───────────────────────────────────────────────
// Terms Nomí wants highlighted arrive as quoted text ("…", `…`, '…'). We pull
// them out of the raw stream and highlight the matching card text ourselves.
const QUOTE_RE = /"([^"\n]{1,60})"|`([^`\n]{1,60})`|'([^'\n]{1,60})'/g

// Index of a trailing, still-open quote in `buf` (so a term split across stream
// chunks isn't lost), or -1. Double quotes / backticks: an odd count means the
// last one is unclosed. A single quote only opens when it starts a word, so
// contractions (don't, it's) never trigger a hold-back.
function lastOpenQuote(buf) {
  let best = -1
  for (const q of ['"', '`']) {
    if ((buf.split(q).length - 1) % 2 === 1) best = Math.max(best, buf.lastIndexOf(q))
  }
  const m = /(?:^|\s)'(?=[^'\n]*$)/.exec(buf)
  if (m) best = Math.max(best, m.index + m[0].length - 1)
  return best
}

// Tokenise into words worth matching against card text: alphabetic words of 4+
// chars and standalone numbers of 2+ digits. No stopword list — the fade-in /
// fade-out transitions on mark.nomi-think-scan keep rapid matches from
// flickering, so we highlight any UI-visible word. Lowercased to match
// _wrapText's case-insensitive search.
function significantWords(text) {
  const out = []
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z'-]{3,}|\d[\d.,:]{1,}/g)) {
    const w = m[0].toLowerCase().replace(/[.,:'-]+$/, '')
    if (w.length >= 2) out.push(w)
  }
  return out
}

// Emoji → expression. Nomí sprinkles emojis through its reasoning; the first
// one in a chunk nudges the eye expression to match its mood.
const EMOJI_TO_EXPR = {
  '😊': 'happy', '😄': 'happy', '😁': 'happy', '🙂': 'happy',
  '🤔': 'thinking', '💭': 'thinking', '🧐': 'focused', '🔍': 'focused', '👀': 'focused',
  '😮': 'surprised', '😲': 'surprised', '😯': 'surprised', '🤯': 'surprised',
  '😢': 'sad', '😔': 'sad', '😞': 'sad',
  '🎉': 'excited', '✨': 'excited', '🤩': 'excited', '🚀': 'excited', '⚡': 'excited',
  '😌': 'warm', '🥰': 'warm', '❤️': 'warm', '💛': 'warm',
  '😬': 'nervous', '😅': 'nervous', '😰': 'nervous',
  '😏': 'playful', '😉': 'playful', '😜': 'playful', '😝': 'playful',
}
const EMOJI_RE = new RegExp('(' + Object.keys(EMOJI_TO_EXPR)
  .map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')')

function firstEmojiExpr(text) {
  const m = EMOJI_RE.exec(text)
  return m ? EMOJI_TO_EXPR[m[1]] : null
}

// Render an array of row objects as an HTML table. Column set is the union of
// all row keys; object cells are shown as compact JSON.
function renderTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return '<p>No data</p>'
  const cols = [...rows.reduce((s, r) => { Object.keys(r ?? {}).forEach(k => s.add(k)); return s }, new Set())]
  const head = '<thead><tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead>'
  const body = '<tbody>' + rows.map(r =>
    '<tr>' + cols.map(c => `<td>${esc(formatCell(r?.[c]))}</td>`).join('') + '</tr>').join('') + '</tbody>'
  return `<table>${head}${body}</table>`
}

function formatCell(v) {
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

// Split text at the last sentence boundary (.!?) that leaves a complete
// portion of at least 30 chars — avoids flushing on abbreviations like
// "Mr." or "e.g." and never sends a half-sentence to TTS.
// Returns [completePart, remainder] or [null, originalText] if no boundary found.
function sentenceSplit(text) {
  for (let i = text.length - 1; i >= 29; i--) {
    if ('.!?'.includes(text[i]) && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return [text.slice(0, i + 1).trim(), text.slice(i + 1).trim()]
    }
  }
  return [null, text]
}

const app = new NomiApp()
document.addEventListener('DOMContentLoaded', () => app.init())
