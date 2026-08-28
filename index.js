/**
 * @cap-js/agents — Public API
 *
 * Eval/testing:
 *   import { Judge, ToxicityJudge, FairnessJudge, ConcisenessJudge,
 *            ToolSelectionJudge, TrajectoryJudge, TrajectoryMatchJudge,
 *            assertToolCall, evalRun } from "@cap-js/agents"
 *
 *   evalRun({ name: "my-eval" })  // register beforeAll/afterAll MLflow hooks
 *
 *   // After agent.ask(), result.metrics contains OTel-derived metrics:
 *   // { input_tokens, output_tokens, total_tokens, tool_call_count, latency_ms, cost_usd }
 *   // Metrics + validation rollup (success_rate, output_correctness) posted to MLflow ootb.
 *
 *   // LLM judges — .criteria(text) and .evaluate(result) → { score, comment, pass }
 *   new Judge("criteria")              // ANSWER_RELEVANCE_PROMPT, continuous
 *   new ToxicityJudge()               // TOXICITY_PROMPT, boolean, pass = not toxic
 *   new FairnessJudge()               // FAIRNESS_PROMPT, boolean, pass = not biased
 *   new ConcisenessJudge()            // CONCISENESS_PROMPT, continuous
 *   new ToolSelectionJudge()          // TOOL_SELECTION_PROMPT, continuous
 *   new TrajectoryJudge("criteria")   // TRAJECTORY_ACCURACY_PROMPT, LLM, continuous
 *
 *   // Deterministic evaluators
 *   new TrajectoryMatchJudge(refMsgs) // exact trajectory match, boolean
 *   assertToolCall(result, "query", { entity: "Books" }) // tool call assertion, boolean
 *
 *   // Multi-turn: pass prior result as second arg to thread contextId
 *   const r1 = await agent.ask("list books")
 *   const r2 = await agent.ask("which is cheapest?", r1)
 *   // judges on r2 auto-post conversation-level assessment on r1's trace in MLflow
 */

export {
  Judge,
  ToxicityJudge,
  FairnessJudge,
  ConcisenessJudge,
  ToolSelectionJudge,
  TrajectoryJudge,
  TrajectoryMatchJudge,
  assertToolCall,
} from "./lib/testing/Judge.js"
export { evalRun } from "./lib/testing/eval-run.js"
