import cds from "@sap/cds"
import { recordScore } from "./eval-run.js"
const LOG = cds.log("agents-judge")
const DEFAULT_JUDGE_MODEL = "gpt-4o"

const DEFAULT_JUDGE_PROMPT = `You are an expert evaluator for an AI assistant.

User question: {inputs}
Actual response: {outputs}

Score 0.0-1.0: does the response fully satisfy the criteria specified in the user question context?
Explain your reasoning, then end with: Thus, the score should be: SCORE_YOU_ASSIGN.`

export class Judge {
  /**
   * @param {string} criteria  Mandatory evaluation criteria.
   * @param {object} [opts]
   * @param {string} [opts.model]       LLM model name.
   * @param {string} [opts.prompt]      openevals judge prompt template.
   * @param {string} [opts.feedbackKey] MLflow assessment name (default: "eval").
   */
  constructor(criteria, { model, prompt, feedbackKey } = {}) {
    if (!criteria || typeof criteria !== "string") {
      throw new TypeError("Judge: first argument 'criteria' is required and must be a string")
    }
    this._criteria = criteria
    this._model = model
    this._prompt = prompt
    this._feedbackKey = feedbackKey ?? "eval"
    this._judgeImpl = null
  }

  async _ensureJudge() {
    if (this._judgeImpl) return this._judgeImpl

    // Save/restore globalThis.expect — openevals/langsmith replaces it at import time.
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

    const { OrchestrationClient } = await import("@sap-ai-sdk/langchain")
    if (savedExpect && globalThis.expect !== savedExpect) globalThis.expect = savedExpect

    const llm = new OrchestrationClient({
      promptTemplating: {
        model: {
          name: this._model || DEFAULT_JUDGE_MODEL,
          params: { temperature: 0 },
        },
      },
    })
    llm[Symbol.for("@cap-js/agents:instrumented")] = true

    this._judgeImpl = openevals.createLLMAsJudge({
      judge: llm,
      prompt: this._prompt || DEFAULT_JUDGE_PROMPT,
      continuous: true,
      feedbackKey: this._feedbackKey,
    })
    return this._judgeImpl
  }

  /** Return a sibling Judge with new criteria, sharing the LLM instance. */
  criteria(criteria) {
    const sibling = new Judge(criteria, {
      model: this._model,
      prompt: this._prompt,
      feedbackKey: this._feedbackKey,
    })
    if (this._judgeImpl) sibling._judgeImpl = this._judgeImpl
    return sibling
  }

  /** Reads result.query and result.text to evaluate */
  async evaluate(result) {
    if (!result) throw new Error(`evaluate called on judge without a result`)
    const judgeImpl = await this._ensureJudge()

    const judgement = await judgeImpl({
      inputs: `Question: ${result.query ?? ""}\nCriteria: ${this._criteria}`,
      outputs: result.text,
    })

    const score = judgement?.score
    const comment = judgement?.comment ?? ""
    LOG.info(`[${this._feedbackKey}] score=${score} — ${comment}`)

    await recordScore(score, comment, {
      traceId: result.traceId,
      assesmentName: this._feedbackKey,
      model: this._model,
    })
    return judgement
  }
}
