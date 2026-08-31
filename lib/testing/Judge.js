import cds from "@sap/cds"
import { recordScore, recordValidation } from "./eval-run.js"

const LOG = cds.log("agents-judge")
const DEFAULT_JUDGE_MODEL = "gpt-4o"

// ─── Base Judge ───────────────────────────────────────────────────────────────

export class Judge {
  constructor(criteria, opts = {}) {
    if (!criteria || typeof criteria !== "string") {
      throw new TypeError("Judge: first argument 'criteria' is required and must be a string")
    }
    this._criteria = criteria
    this._model = opts.model || DEFAULT_JUDGE_MODEL
    this._assessmentName = opts.assessmentName ?? "relevance"
    this._promptKey = opts.promptKey ?? "ANSWER_RELEVANCE_PROMPT"
    this._continuous = opts._continuous ?? true
    this._judgeImpl = null
  }

  async _ensureJudge() {
    if (this._judgeImpl) return this._judgeImpl
    this._judgeImpl = await _loadJudgeImpl(
      this._model,
      this._promptKey,
      this._assessmentName,
      this._continuous,
    )
    return this._judgeImpl
  }

  /** Sibling with new criteria, sharing the LLM instance. */
  criteria(criteria) {
    const sibling = new this.constructor(criteria, {
      model: this._model,
      assessmentName: this._assessmentName,
      promptKey: this._promptKey,
      _continuous: this._continuous,
    })
    if (this._judgeImpl) sibling._judgeImpl = this._judgeImpl
    return sibling
  }

  /** @returns {Promise<{score, comment, pass}>} */
  async evaluate(result) {
    if (!result) throw new Error("evaluate: result is required")
    const judgeImpl = await this._ensureJudge()
    const judgement = await judgeImpl(this._buildInput(result))
    const raw = judgement?.score
    const score = typeof raw === "boolean" ? raw : (raw ?? 0)
    const pass = typeof score === "boolean" ? score : score >= 0.5
    const comment = judgement?.comment ?? ""
    LOG.info(`[${this._assessmentName}] score=${score} pass=${pass} — ${comment}`)
    recordValidation(result, pass)
    await recordScore(score, comment, {
      traceId: result.traceId,
      assessmentName: this._assessmentName,
      model: this._model,
    })
    return { score, comment, pass }
  }

  _buildInput(result) {
    return {
      inputs: `Question: ${result.query ?? ""}\nCriteria: ${this._criteria}`,
      outputs: result.text,
    }
  }
}

// ─── Single-turn judges ───────────────────────────────────────────────────────

/** TOXICITY_PROMPT — pass = not toxic */
export class ToxicityJudge extends Judge {
  constructor(criteria = "Response must not contain toxic language.", opts = {}) {
    super(criteria, {
      assessmentName: "toxicity",
      ...opts,
      promptKey: "TOXICITY_PROMPT",
      _continuous: false,
    })
  }
}

/** FAIRNESS_PROMPT — pass = not biased */
export class FairnessJudge extends Judge {
  constructor(criteria = "Response must not contain biased or discriminatory content.", opts = {}) {
    super(criteria, {
      assessmentName: "fairness",
      ...opts,
      promptKey: "FAIRNESS_PROMPT",
      _continuous: false,
    })
  }

  async evaluate(result) {
    const j = await super.evaluate(result)
    return { ...j, pass: !j.score }
  }
}

/** CONCISENESS_PROMPT — continuous score */
export class ConcisenessJudge extends Judge {
  constructor(criteria = "Response must be concise without unnecessary verbosity.", opts = {}) {
    super(criteria, {
      assessmentName: "conciseness",
      ...opts,
      promptKey: "CONCISENESS_PROMPT",
      _continuous: true,
    })
  }
}

/** TOOL_SELECTION_PROMPT — passes tool calls as trajectory */
export class ToolSelectionJudge extends Judge {
  constructor(criteria = "Agent must select appropriate tools in the right order.", opts = {}) {
    super(criteria, {
      assessmentName: "tool_selection",
      ...opts,
      promptKey: "TOOL_SELECTION_PROMPT",
      _continuous: true,
    })
  }

  _buildInput(result) {
    const trajectory =
      (result.toolCalls ?? [])
        .map((tc, i) => `${i + 1}. ${tc.tool}(${JSON.stringify(tc.args)})`)
        .join("\n") || "(no tool calls)"
    return {
      inputs: `Question: ${result.query ?? ""}\nCriteria: ${this._criteria}`,
      outputs: trajectory,
    }
  }
}

/** TRAJECTORY_ACCURACY_PROMPT — scores result.messages as trajectory */
export class TrajectoryJudge extends Judge {
  constructor(criteria, opts = {}) {
    super(criteria, { assessmentName: "trajectory", ...opts, promptKey: null, _continuous: true })
    this._trajectoryJudgeImpl = null
  }

  async _ensureJudge() {
    if (this._trajectoryJudgeImpl) return this._trajectoryJudgeImpl
    const openevals = await _loadOpenevals()
    const llm = await _buildLlm(this._model)
    this._trajectoryJudgeImpl = openevals.createTrajectoryLLMAsJudge({
      judge: llm,
      assessmentName: this._assessmentName,
    })
    this._judgeImpl = this._trajectoryJudgeImpl
    return this._trajectoryJudgeImpl
  }

  _buildInput(result) {
    return {
      inputs: `Question: ${result.query ?? ""}\nCriteria: ${this._criteria}`,
      outputs: result.messages ?? [],
    }
  }
}

/** Deterministic trajectory match against a reference list. */
export class TrajectoryMatchJudge {
  constructor(referenceMessages, { mode = "subset", argsMode = "ignore", assessmentName } = {}) {
    if (!Array.isArray(referenceMessages))
      throw new TypeError("TrajectoryMatchJudge: first argument must be an array of messages")
    this._reference = referenceMessages
    this._mode = mode
    this._argsMode = argsMode
    this._assessmentName = assessmentName ?? "trajectory_match"
    this._evalImpl = null
  }

  async _ensureImpl() {
    if (this._evalImpl) return this._evalImpl
    const openevals = await _loadOpenevals()
    this._evalImpl = openevals.createTrajectoryMatchEvaluator({
      trajectoryMatchMode: this._mode,
      toolArgsMatchMode: this._argsMode,
    })
    return this._evalImpl
  }

  async evaluate(result) {
    if (!result) throw new Error("evaluate: result is required")
    const raw = await (
      await this._ensureImpl()
    )({ outputs: result.messages ?? [], referenceOutputs: this._reference })
    const pass = !!raw?.score
    const comment = raw?.comment ?? ""
    LOG.info(`[${this._assessmentName}] pass=${pass} — ${comment}`)
    recordValidation(result, pass)
    await recordScore(pass, comment, {
      traceId: result.traceId,
      assessmentName: this._assessmentName,
      sourceType: "CODE",
    })
    return { pass, score: pass ? 1 : 0, comment }
  }
}

// ─── assertToolCall ───────────────────────────────────────────────────────────

/** Deterministic tool call assertion. Contributes to success_rate rollup. */
export function assertToolCall(result, toolName, matcher) {
  const match = (result?.toolCalls ?? []).find((c) => {
    if (c.tool !== toolName) return false
    if (matcher === undefined) return true
    if (typeof matcher === "function") return !!matcher(c.args)
    return _partialMatch(c.args, matcher)
  })
  const pass = !!match
  recordValidation(result, pass)
  return { pass, call: match ?? null }
}

function _partialMatch(actual, expected) {
  if (!expected || typeof expected !== "object") return actual === expected
  for (const [k, v] of Object.entries(expected)) {
    if (actual?.[k] !== v) return false
  }
  return true
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _loadOpenevals() {
  const savedExpect = globalThis.expect
  let openevals
  try {
    openevals = await import("openevals")
  } catch (err) {
    throw new Error(
      "openevals is required for Judge.evaluate(). Install it as a devDependency:\n  npm install --save-dev openevals\n" +
        `Original error: ${err.message}`,
      { cause: err },
    )
  }
  if (savedExpect && globalThis.expect !== savedExpect) globalThis.expect = savedExpect
  return openevals
}

async function _buildLlm(model) {
  const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")
  const llm = new OrchestrationClient({
    promptTemplating: { model: { name: model, params: { temperature: 0 } } },
  })
  llm[Symbol.for("@cap-js/agents:instrumented")] = true
  return llm
}

async function _loadJudgeImpl(model, promptKey, assessmentName, continuous) {
  const openevals = await _loadOpenevals()
  const llm = await _buildLlm(model)
  const prompt = openevals[promptKey]
  if (!prompt) throw new Error(`openevals prompt not found: ${promptKey}`)
  return openevals.createLLMAsJudge({ judge: llm, prompt, continuous, assessmentName })
}

// ─── ConversationJudge ────────────────────────────────────────────────────────

/** Base for session-level judges. evaluate([r1, r2, ...]) — all turns, same contextId. */
export class ConversationJudge {
  constructor({ model, assessmentName } = {}) {
    this._model = model || DEFAULT_JUDGE_MODEL
    this._assessmentName = assessmentName ?? this.constructor._assessmentName ?? "conversation"
    this._promptKey = this.constructor._promptKey
    this._continuous = this.constructor._continuous ?? false
    this._judgeImpl = null
  }

  async _ensureJudge() {
    if (this._judgeImpl) return this._judgeImpl
    this._judgeImpl = await _loadJudgeImpl(
      this._model,
      this._promptKey,
      this._assessmentName,
      this._continuous,
    )
    return this._judgeImpl
  }

  async evaluate(results) {
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(
        `${this.constructor.name}.evaluate: requires a non-empty array of chat() results`,
      )
    }
    const judgeImpl = await this._ensureJudge()
    const judgement = await judgeImpl({ outputs: results.flatMap((r) => r.messages ?? []) })
    const raw = judgement?.score
    const score = typeof raw === "boolean" ? raw : (raw ?? 0)
    const pass = typeof score === "boolean" ? score : score >= 0.5
    const comment = judgement?.comment ?? ""
    LOG.info(`[${this._assessmentName}] pass=${pass} score=${score} — ${comment}`)
    const first = results[0]
    await recordScore(pass, comment, {
      traceId: first.traceId,
      sessionId: first.contextId,
      assessmentName: this._assessmentName,
      model: this._model,
      conversationLevel: true,
    })
    return { score, comment, pass }
  }
}

/** All user requests addressed? (TASK_COMPLETION_PROMPT) */
export class TaskCompletionJudge extends ConversationJudge {
  static _promptKey = "TASK_COMPLETION_PROMPT"
  static _assessmentName = "conversation_completeness"
  static _continuous = false
}

/** User satisfied at end of conversation? (USER_SATISFACTION_PROMPT) */
export class UserSatisfactionJudge extends ConversationJudge {
  static _promptKey = "USER_SATISFACTION_PROMPT"
  static _assessmentName = "user_satisfaction"
  static _continuous = false
}

/** Facts retained across turns? (KNOWLEDGE_RETENTION_PROMPT) */
export class KnowledgeRetentionJudge extends ConversationJudge {
  static _promptKey = "KNOWLEDGE_RETENTION_PROMPT"
  static _assessmentName = "knowledge_retention"
  static _continuous = false
}

/** No errors perceived? (PERCEIVED_ERROR_PROMPT) — inverted: pass = no error */
export class PerceivedErrorJudge extends ConversationJudge {
  static _promptKey = "PERCEIVED_ERROR_PROMPT"
  static _assessmentName = "perceived_error"
  static _continuous = false

  async evaluate(results) {
    const j = await super.evaluate(results)
    return { ...j, pass: !j.score }
  }
}

/** Appropriate tone throughout? (AGENT_TONE_PROMPT) */
export class AgentToneJudge extends ConversationJudge {
  static _promptKey = "AGENT_TONE_PROMPT"
  static _assessmentName = "agent_tone"
  static _continuous = false
}
