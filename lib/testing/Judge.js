import cds from "@sap/cds"
import { recordScore, recordValidation } from "./eval-run.js"

const LOG = cds.log("agents-judge")
const DEFAULT_JUDGE_MODEL = "gpt-4o"

// ─── Base Judge ───────────────────────────────────────────────────────────────

/**
 * Base LLM-as-judge backed by openevals.ANSWER_RELEVANCE_PROMPT.
 * Returns a continuous 0–1 score. Use subclasses for typed validations.
 *
 *   const judge = new Judge("must list multiple books")
 *   const { score, pass } = await judge.evaluate(result)
 *   judge.criteria("different criteria") → sibling sharing the LLM instance
 */
export class Judge {
  /**
   * @param {string} criteria  Mandatory evaluation criteria.
   * @param {object} [opts]
   * @param {string} [opts.model]       LLM model name. Default: "gpt-4o".
   * @param {string} [opts.assessmentName] MLflow assessment name. Default: "eval".
   * @param {string} [opts.promptKey] openevals prompt key
   */
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

  /** Return a sibling with new criteria, sharing the LLM instance. */
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

  /**
   * Evaluate an agent.ask() result.
   * @returns {Promise<{score: number|boolean, comment: string, pass: boolean}>}
   */
  async evaluate(result) {
    if (!result) throw new Error("evaluate: result is required")
    const judgeImpl = await this._ensureJudge()

    const judgement = await judgeImpl(this._buildInput(result))

    const raw = judgement?.score
    // continuous → numeric; boolean prompt → raw is true/false/"yes"/"no"
    const score = typeof raw === "boolean" ? raw : (raw ?? 0)
    const pass = typeof score === "boolean" ? score : score >= 0.5
    const comment = judgement?.comment ?? ""

    LOG.info(`[${this._assessmentName}] score=${score} pass=${pass} — ${comment}`)

    recordValidation(result, pass)
    await recordScore(score, comment, {
      traceId: result.traceId,
      conversationTraceId: result._conversationTraceId,
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

// ─── Safety / quality judges (openevals prompts, boolean output) ──────────────

/**
 * Detects toxic language in the agent response.
 * Uses openevals TOXICITY_PROMPT. pass = true = NOT toxic
 */
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

/**
 * Detects biased or unfair content in the agent response.
 * Uses openevals FAIRNESS_PROMPT. pass = true = NOT biased.
 */
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
    const judgement = await super.evaluate(result)
    // Invert: FAIRNESS_PROMPT returns true when biased → pass = NOT biased
    return { ...judgement, pass: !judgement.score }
  }
}

/**
 * Evaluates conciseness of the agent response.
 * Uses openevals CONCISENESS_PROMPT.
 */
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

/**
 * Evaluates whether the agent selected appropriate tools.
 * Uses openevals TOOL_SELECTION_PROMPT with tool calls as trajectory.
 */
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
    // TOOL_SELECTION_PROMPT uses {outputs} as the trajectory
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

// ─── TrajectoryJudge ──────────────────────────────────────────────────────────

/**
 * LLM-as-judge for agent trajectories using openevals createTrajectoryLLMAsJudge.
 * Scores the full message trajectory (result.messages) against a criteria.
 * Uses TRAJECTORY_ACCURACY_PROMPT by default.
 *
 *   new TrajectoryJudge("must call getStock before responding with a number")
 *   await judge.evaluate(result)
 */
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

// ─── TrajectoryMatchJudge ─────────────────────────────────────────────────────

/**
 * Deterministic trajectory match using openevals createTrajectoryMatchEvaluator.
 * Compares result.messages against a reference message list. boolean pass/fail.
 *
 *   const judge = new TrajectoryMatchJudge(referenceMessages, { mode: "subset" })
 *   const { pass } = await judge.evaluate(result)
 *
 * @param {object[]} referenceMessages  Expected LangChain messages to compare against.
 * @param {object} [opts]
 * @param {"strict"|"unordered"|"subset"|"superset"} [opts.mode="subset"]  Match mode.
 * @param {"exact"|"ignore"|"subset"|"superset"} [opts.argsMode="ignore"]  Tool args match mode.
 */
export class TrajectoryMatchJudge {
  constructor(referenceMessages, { mode = "subset", argsMode = "ignore", assessmentName } = {}) {
    if (!Array.isArray(referenceMessages)) {
      throw new TypeError("TrajectoryMatchJudge: first argument must be an array of messages")
    }
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
    const evalImpl = await this._ensureImpl()

    const raw = await evalImpl({
      outputs: result.messages ?? [],
      referenceOutputs: this._reference,
    })

    const pass = !!raw?.score
    const comment = raw?.comment ?? ""

    LOG.info(`[${this._assessmentName}] pass=${pass} — ${comment}`)

    recordValidation(result, pass)
    await recordScore(pass, comment, {
      traceId: result.traceId,
      conversationTraceId: result._conversationTraceId,
      assessmentName: this._assessmentName,
      model: "CODE", // Model is mapped to source type of assessment
    })

    return { pass, score: pass ? 1 : 0, comment }
  }
}

// ─── assertToolCall ───────────────────────────────────────────────────────────

/**
 * Deterministic assertion — checks result.toolCalls for a matching call.
 * Records the pass/fail into result's validation accumulator for success_rate rollup.
 *
 *   assertToolCall(result, "query")                          — any call with that name
 *   assertToolCall(result, "query", { entity: "Books" })     — partial args match
 *   assertToolCall(result, "getStock", (args) => args.book === 42)  — predicate
 *
 * @param {object} result      Return value of agent.ask()
 * @param {string} toolName    Expected tool name
 * @param {object|Function} [matcher]  Partial args object or predicate (args) => boolean
 * @returns {{ pass: boolean, call: object|null }}
 */
export function assertToolCall(result, toolName, matcher) {
  const calls = result?.toolCalls ?? []
  const match = calls.find((c) => {
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

async function _loadOpenevals() {
  const savedExpect = globalThis.expect
  let openevals
  try {
    openevals = await import("openevals")
  } catch (err) {
    throw new Error(
      "openevals is required for Judge.evaluate(). Install it as a devDependency:\n" +
        "  npm install --save-dev openevals\n" +
        `Original error: ${err.message}`,
    )
  }
  if (savedExpect && globalThis.expect !== savedExpect) globalThis.expect = savedExpect
  return openevals
}

async function _buildLlm(model) {
  const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")
  const llm = new OrchestrationClient({
    promptTemplating: {
      model: { name: model, params: { temperature: 0 } },
    },
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
