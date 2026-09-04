import cds from "@sap/cds"
import { recordEvaluation } from "./eval-run.js"

const LOG = cds.log("agents-judge")
const CRITERIA_SEPARATOR = "\n\n"

// ─── Base Judge ───────────────────────────────────────────────────────────────

export class Judge {
  constructor(opts) {
    _assertSingleConstructorArg(arguments)
    const { criteria, assessmentName, continuous, invertedScala, type } = _judgeOptions(
      opts,
      "ANSWER_RELEVANCE_PROMPT",
      arguments.length,
    )
    if (!criteria || typeof criteria !== "string") {
      throw new TypeError("Judge: 'criteria' is required and must be a string")
    }
    if (type !== undefined && type !== "trajectory") {
      throw new TypeError("Judge: 'type' must be 'trajectory' when provided")
    }
    this._criteria = criteria
    this._type = type
    const isInvertedScala = (criteria) => {
      if (_promptKeyFromCriteria(criteria) === "TOXICITY_PROMPT") {
        return true
      }
      return false
    }
    this._invertedScala = invertedScala ?? isInvertedScala(criteria)

    this._assessmentName =
      assessmentName ?? _assessmentNameFromCriteria(this._criteria, this._defaultAssessmentName())
    this._continuous = continuous ?? true
    this._judgeImpl = null
    this._sessionJudgeImpl = null
  }

  _defaultAssessmentName() {
    return this._type === "trajectory" ? "trajectory" : "relevance"
  }

  async _ensureJudge(type) {
    const judgeType = arguments.length === 0 ? this._type : type
    if (judgeType === this._type && this._judgeImpl) return this._judgeImpl
    if (judgeType !== this._type && this._sessionJudgeImpl) return this._sessionJudgeImpl
    const judgeImpl = await _loadJudgeImpl(
      this._criteria,
      this._assessmentName,
      this._continuous,
      judgeType,
    )
    if (judgeType === this._type) this._judgeImpl = judgeImpl
    else this._sessionJudgeImpl = judgeImpl
    return judgeImpl
  }

  /** Sibling with appended prompt/criteria. */
  criteria(criteria) {
    if (!criteria || typeof criteria !== "string") {
      throw new TypeError("Judge.criteria: argument 'criteria' is required and must be a string")
    }
    const sibling = new this.constructor({
      criteria: `${this._criteria}${CRITERIA_SEPARATOR}${criteria}`,
      assessmentName: this._assessmentName,
      continuous: this._continuous,
      type: this._type,
    })
    return sibling
  }

  /** @returns {Promise<{score, comment, pass}>} */
  async evaluate(result) {
    if (!result) throw new Error("evaluate: result is required")
    if (Array.isArray(result)) return this._evaluateSession(result)
    const judgeImpl = await this._ensureJudge()
    const judgement = await judgeImpl(this._buildInput(result))
    const { score, pass, comment } = this._judgementResult(judgement)
    LOG.debug(`[${this._assessmentName}] score=${score} pass=${pass} — ${comment}`)
    await recordEvaluation(result, {
      pass,
      score,
      comment,
      assessmentName: this._assessmentName,
    })
    return { score, comment, pass }
  }

  async _evaluateSession(results) {
    if (results.length === 0) {
      throw new Error(
        "Judge.evaluate: session assessment requires a non-empty array of chat() results",
      )
    }
    const judgeImpl = await this._ensureJudge(undefined)
    const judgement = await judgeImpl({ outputs: results.flatMap((r) => r.messages ?? []) })
    const { score, pass, comment } = this._judgementResult(judgement)
    LOG.info(`[${this._assessmentName}] pass=${pass} score=${score} — ${comment}`)
    const first = results[0]
    await recordEvaluation(first, {
      score: pass,
      comment,
      sessionId: first.contextId,
      assessmentName: this._assessmentName,
      conversationLevel: true,
    })
    return { score, comment, pass }
  }

  _judgementResult(judgement) {
    const raw = judgement?.score
    const score = typeof raw === "boolean" ? raw : (raw ?? 0)
    const pass = this._invertedScala
      ? typeof score === "boolean"
        ? !score
        : score <= 0.5
      : typeof score === "boolean"
        ? score
        : score >= 0.5
    const comment = judgement?.comment ?? ""
    return { score, comment, pass }
  }

  _buildInput(result) {
    if (this._type === "trajectory") {
      return {
        inputs: result.query ?? "",
        outputs: result.messages ?? [],
      }
    }
    return {
      inputs: result.query ?? "",
      outputs: result.text,
    }
  }
}

// ─── matchToolCall ───────────────────────────────────────────────────────────

/** Deterministic tool call assertion. Contributes to success_rate rollup. */
export function matchToolCall(result, toolName, matcher) {
  const match = (result?.toolCalls ?? []).find((c) => {
    if (c.tool !== toolName) return false
    if (matcher === undefined) return true
    if (typeof matcher === "function") return !!matcher(c.args)
    return _partialMatch(c.args, matcher)
  })
  const pass = !!match
  recordEvaluation(result, { pass })
  return pass
}

function _partialMatch(actual, expected) {
  if (!expected || typeof expected !== "object") return actual === expected
  for (const [k, v] of Object.entries(expected)) {
    if (actual?.[k] !== v) return false
  }
  return true
}

function _judgeOptions(opts, defaultCriteria = "ANSWER_RELEVANCE_PROMPT", argCount = 1) {
  if (argCount === 0 || opts === undefined) return { criteria: defaultCriteria }
  if (typeof opts === "string") return { criteria: opts }
  if (opts && typeof opts === "object")
    return { ...opts, criteria: opts.criteria ?? defaultCriteria }
  throw new TypeError("Judge: constructor argument must be a string or an object")
}

function _assertSingleConstructorArg(args) {
  if (args.length > 1) throw new TypeError("Judge: constructor accepts a single argument")
}

function _assessmentNameFromCriteria(criteria, fallback) {
  const key = _promptKeyFromCriteria(criteria)
  return key ? key.replace(/_PROMPT$/, "").toLowerCase() : fallback
}

function _promptKeyFromCriteria(criteria) {
  if (!criteria || typeof criteria !== "string") return null
  const key = criteria.split(CRITERIA_SEPARATOR, 1)[0].trim()
  return key.endsWith("_PROMPT") ? key : null
}

function _resolvePrompt(openevals, criteria) {
  if (Object.prototype.hasOwnProperty.call(openevals, criteria)) return openevals[criteria]
  const key = _promptKeyFromCriteria(criteria)
  if (!key || !Object.prototype.hasOwnProperty.call(openevals, key)) return criteria
  const rest = criteria.slice(criteria.indexOf(key) + key.length).trimStart()
  return rest ? `${openevals[key]}${CRITERIA_SEPARATOR}${rest}` : openevals[key]
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

async function _buildLlm() {
  const name = "llm"
  const { kind, impl, ...options } = cds.requires[name] ?? {}
  const providerImpl = impl ?? cds.requires.kinds?.[kind]?.impl
  if (!providerImpl) throw new Error("No service implementation found for " + name)
  const { default: LLMProvider } = await import(providerImpl)
  const llm = new LLMProvider(name, options)
  llm[Symbol.for("@cap-js/agents:instrumented")] = true
  return llm
}

async function _loadJudgeImpl(criteria, assessmentName, continuous, type) {
  const openevals = await _loadOpenevals()
  const llm = await _buildLlm()
  const prompt = _resolvePrompt(openevals, criteria)
  if (type === "trajectory") {
    return openevals.createTrajectoryLLMAsJudge({ judge: llm, prompt, assessmentName })
  }
  return openevals.createLLMAsJudge({ judge: llm, prompt, continuous, assessmentName })
}
